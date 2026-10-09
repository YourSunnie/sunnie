import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { attachmentMessageText, buildAttachmentContent } from '../src/attachments/content.ts';
import { renderForSummary } from '../src/agent/compaction.ts';
import { estimateMessageTokens } from '../src/agent/tokens.ts';
import { LocalComputer, shq } from '../src/computer/computer.ts';
import { createModelRegistry } from '../src/models/registry.ts';
import { buildState } from '../src/router/jev.ts';
import type { Attachment } from '../src/store/attachments.ts';
import type { StoredMessage } from '../src/store/conversations.ts';
import { testConfig } from './helpers.ts';

function attachment(id: string, filename: string, mediaType: string, data: Uint8Array): Attachment & { data: Uint8Array } {
  return { id, filename, mediaType, sizeBytes: data.byteLength, createdAt: '2026-10-03T00:00:00.000Z', data };
}

async function computerFor(t: TestContext): Promise<LocalComputer | undefined> {
  const workspace = mkdtempSync(join(tmpdir(), 'sunnie-attachments-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const computer = new LocalComputer({ workspace });
  if ((await computer.exec('command -v python3', { timeoutMs: 5000 })).exitCode !== 0) {
    t.skip('Python 3 is unavailable on this computer');
    return undefined;
  }
  return computer;
}

async function officeFile(computer: LocalComputer, entries: Record<string, string>): Promise<Uint8Array> {
  const script = 'import base64,io,json,sys,zipfile\nbuf=io.BytesIO()\nwith zipfile.ZipFile(buf,"w",zipfile.ZIP_DEFLATED) as z:\n for path,text in json.load(sys.stdin).items(): z.writestr(path,text)\nprint(base64.b64encode(buf.getvalue()).decode())';
  const result = await computer.exec(`python3 -c ${shq(script)}`, { stdin: JSON.stringify(entries), timeoutMs: 5000 });
  assert.equal(result.exitCode, 0, result.stderr);
  return Buffer.from(result.stdout.trim(), 'base64');
}

test('attachments use canonical image bytes and preserve a working original without rewriting it', async (t) => {
  const computer = await computerFor(t);
  if (!computer) return;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  const file = attachment('att_photo', 'photo.png', 'image/png', png);
  const content = await buildAttachmentContent(computer, [file]);
  assert.deepEqual(content.find((part) => part.type === 'file'), { type: 'file', mediaType: 'image/png', data: png.toString('base64'), filename: 'photo.png' });
  const workingPath = join(computer.workspace, 'Attachments/att_photo/original/photo.png');
  assert.deepEqual(readFileSync(workingPath), png);
  const snapshot = JSON.stringify(content);
  writeFileSync(workingPath, 'changed on the computer');
  assert.equal(JSON.stringify(content), snapshot);
  const repeated = await buildAttachmentContent(computer, [file]);
  assert.equal(readFileSync(workingPath, 'utf8'), 'changed on the computer');
  assert.deepEqual(repeated.find((part) => part.type === 'file'), content.find((part) => part.type === 'file'));
});

test('disabled native media stays explicit and PDF transport capability is resolved centrally', async (t) => {
  const computer = await computerFor(t);
  if (!computer) return;
  const file = attachment('att_pdf', 'plan.pdf', 'application/pdf', Buffer.from('%PDF-1.7\nfixture'));
  const content = await buildAttachmentContent(computer, [file], undefined, { images: false, pdf: false });
  assert.ok(content.every((part) => part.type === 'text'));
  assert.match(JSON.stringify(content), /Native PDF input is disabled/);
  assert.match(JSON.stringify(content), /original\/plan.pdf/);
  const config = testConfig({
    providers: { local: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:1/v1' }, ds: { type: 'deepseek', apiKey: 'test' } },
    models: { 'local/text-only': { media: { images: false, pdf: false } } },
  });
  const models = createModelRegistry(config, {});
  assert.deepEqual(models.resolve('local/text-only').media, { images: false, pdf: false });
  assert.equal(models.resolve('ds/any-pinned-model').media?.pdf, false);
});

test('document excerpts are bounded while their paths remain in routing and compaction', async (t) => {
  const computer = await computerFor(t);
  if (!computer) return;
  const text = 'A useful detail.\n'.repeat(4000);
  const file = attachment('att_notes', 'notes.txt', 'text/plain', Buffer.from(text));
  const content = await buildAttachmentContent(computer, [file]);
  assert.match(JSON.stringify(content), /excerptClipped/);
  assert.ok(JSON.stringify(content).length < 30_000);
  assert.equal(readFileSync(join(computer.workspace, 'Attachments/att_notes/text.txt'), 'utf8'), text);
  const message: StoredMessage = {
    id: 'msg_file', conversationId: 'conv_file', seq: 1, role: 'user', content, text: 'Use my notes.',
    origin: null, model: null, runId: null, createdAt: file.createdAt,
  };
  const rendered = attachmentMessageText(message);
  assert.match(rendered, /notes\.txt/);
  assert.match(renderForSummary(message), /textPath/);
  assert.match(renderForSummary(message), /A useful detail/);
  assert.match(JSON.stringify(buildState({ summary: null, messages: [message] })), /notes\.txt/);
  assert.doesNotMatch(rendered, /A useful detail/);
});

test('DOCX extracts paragraphs and rejects XML entity declarations', async (t) => {
  const computer = await computerFor(t);
  if (!computer) return;
  const docx = await officeFile(computer, {
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Arrival</w:t><w:tab/><w:t>Friday</w:t></w:r></w:p><w:p><w:r><w:t>Return Sunday</w:t></w:r></w:p></w:body></w:document>',
  });
  const content = await buildAttachmentContent(computer, [attachment('att_doc', 'trip.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx)]);
  assert.match(JSON.stringify(content), /Arrival\\tFriday\\nReturn Sunday/);
  const hostile = await officeFile(computer, { 'word/document.xml': '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><x>&secret;</x>' });
  const blocked = await buildAttachmentContent(computer, [attachment('att_entities', 'document.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', hostile)]);
  assert.match(JSON.stringify(blocked), /entity declarations is not supported/);
  assert.ok(blocked.every((part) => part.type !== 'file'));
});

test('PPTX uses presentation order instead of slide filenames', async (t) => {
  const computer = await computerFor(t);
  if (!computer) return;
  const pptx = await officeFile(computer, {
    'ppt/presentation.xml': '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="second"/><p:sldId r:id="first"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<s xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Closing</a:t></a:r></a:p></s>',
    'ppt/slides/slide2.xml': '<s xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Opening</a:t></a:r></a:p></s>',
  });
  const content = await buildAttachmentContent(computer, [attachment('att_slides', 'talk.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', pptx)]);
  const rendered = JSON.stringify(content);
  assert.ok(rendered.indexOf('Opening') < rendered.indexOf('Closing'));
  assert.match(rendered, /Opening/);
});

test('token estimates count readable text and media reserve, never base64 as prose', () => {
  const small = estimateMessageTokens({ content: [{ type: 'file', mediaType: 'image/png', data: 'A'.repeat(4000) }] });
  const large = estimateMessageTokens({ content: [{ type: 'file', mediaType: 'image/png', data: 'A'.repeat(4_000_000) }] });
  assert.equal(large, small);
  assert.ok(large < 10_000);
  const pdf = estimateMessageTokens({ content: [{ type: 'file', mediaType: 'application/pdf', data: 'A'.repeat(4_000_000) }] });
  assert.ok(pdf > small && pdf < 100_000);
  assert.ok(estimateMessageTokens({ content: [{ type: 'text', text: 'A'.repeat(40_000) }] }) > 10_000);
});

test('XLSX preserves sheet names, cell addresses, and shared strings without evaluating formulas', async (t) => {
  const computer = await computerFor(t);
  if (!computer) return;
  const xlsx = await officeFile(computer, {
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Budget" r:id="sheet"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="sheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Hotel</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>250</v></c><c r="C1"><f>B1*2</f></c></row></sheetData></worksheet>',
  });
  const content = await buildAttachmentContent(computer, [attachment('att_sheet', 'budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsx)]);
  const rendered = JSON.stringify(content);
  assert.match(rendered, /Sheet: Budget/);
  assert.match(rendered, /A1: Hotel/);
  assert.match(rendered, /B1: 250/);
  assert.match(rendered, /formula has no cached value/);
});

test('unsupported images use a canonical visual derivative while the original stays unchanged', async (t) => {
  const computer = await computerFor(t);
  if (!computer) return;
  const original = Buffer.from('0000001866747970686569630000000068656963', 'hex');
  const preview = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  const file = { ...attachment('att_heic', 'holiday.heic', 'image/heic', original), preview: { data: preview, mediaType: 'image/png' } };
  const content = await buildAttachmentContent(computer, [file]);
  assert.deepEqual(content.find((part) => part.type === 'file'), {
    type: 'file', filename: 'holiday.png', mediaType: 'image/png', data: preview.toString('base64'),
  });
  assert.deepEqual(readFileSync(join(computer.workspace, 'Attachments/att_heic/original/holiday.heic')), original);
  assert.match(attachmentMessageText({ text: '', content }), /derived visual representation/);
  const withoutVision = await buildAttachmentContent(computer, [file], undefined, { images: false, pdf: true });
  assert.ok(withoutVision.every((part) => part.type !== 'file'));
  const snapshot = JSON.stringify(content);
  preview.fill(0);
  assert.equal(JSON.stringify(content), snapshot);
});

test('supported originals take priority and invalid or oversized previews are not sent', async (t) => {
  const computer = await computerFor(t);
  if (!computer) return;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  const original = attachment('att_supported', 'photo.png', 'image/png', png);
  const content = await buildAttachmentContent(computer, [{ ...original, preview: { data: Buffer.from([0xff, 0xd8, 0xff]), mediaType: 'image/jpeg' } }]);
  assert.deepEqual(content.find((part) => part.type === 'file'), { type: 'file', filename: 'photo.png', mediaType: 'image/png', data: png.toString('base64') });
  const heic = attachment('att_invalid_preview', 'photo.heic', 'image/heic', Buffer.from('original bytes'));
  const invalid = await buildAttachmentContent(computer, [{ ...heic, preview: { data: Buffer.from('not a PNG'), mediaType: 'image/png' } }]);
  assert.ok(invalid.every((part) => part.type !== 'file'));
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);
  oversized.set([0xff, 0xd8, 0xff]);
  const large = await buildAttachmentContent(computer, [{ ...heic, preview: { data: oversized, mediaType: 'image/jpeg' } }]);
  assert.ok(large.every((part) => part.type !== 'file'));
});
