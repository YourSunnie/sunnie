import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { HomeStore, HomeWidget } from '../home/home-store.ts';
import type { DriveClient } from '../drive/client.ts';
import { describeCardState } from '../home/cards.ts';
import { applyValues, drivePaths, SIZE_RULES, parseWidgetBody, widgetAction, widgetKeys, withKeys, type WidgetAction } from '../home/widgets.ts';

function widgetActionOf(value: unknown): WidgetAction {
  const result = widgetAction.safeParse(value);
  if (!result.success) throw new Error(`\`file\` is not right: ${z.prettifyError(result.error)}`);
  return result.data;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… (cut)` : text);

/** One widget as the model reads it: where it is, how long it stays, and its content. */
export function describeWidget(w: HomeWidget): string {
  const stays = w.expiresAt ? `until ${w.expiresAt}` : 'stays';
  const width = w.columns === 4 ? 'full width' : `${w.columns} of 4 columns`;
  const keys = widgetKeys(withKeys(w.body));
  const notes = [stays, width, w.hidden ? 'hidden' : '', keys.length ? `keys: ${keys.join(', ')}` : 'no keys'].filter(Boolean).join(', ');
  const set = w.state ? ` The user has set: ${describeCardState(w.body, w.state)}.` : '';
  return `- ${w.id}${w.title ? ` "${w.title}"` : ''} (${notes}): ${clip(JSON.stringify(w.body), 400)}${set}`;
}

/**
 * A widget that points at a file the user cannot open is worse than no widget, and the model
 * tends to guess paths: every Drive path is looked up before the widget is written.
 */
async function requireInDrive(drive: DriveClient, paths: string[]): Promise<void> {
  if (paths.length > 12) throw new Error('A widget can point at up to 12 Drive files. Link a folder instead.');
  for (const path of paths) {
    try {
      await drive.stat(path);
    } catch (err) {
      throw new Error(`"${path}" could not be found in Drive (${err instanceof Error ? err.message : String(err)}). Paths are relative to ~/Drive and must match exactly: list the folder with the shell to find the real name, then try again.`);
    }
  }
}

export function createHomeTools(home: HomeStore, drive: DriveClient): ToolSet {
  return {
    home_widget: tool({
      description:
        "Change the Home screen of the user's app, where they look first. Home is a list of widgets, top to bottom; " +
        'each has an `id` and a `body` you write as JSON. Use it in a Home brief, or when the user asks to put or pin ' +
        'something on Home, change it, move it or take it off. Not a way to answer: what they asked for goes in your reply.\n' +
        'action "set" writes a widget whole, design and all (a new id adds one, a known id replaces it and keeps its place); ' +
        '"update" changes only what it shows and keeps its design; "remove" takes it off; "move" puts it above `before` (or last); ' +
        '"hide" / "show" keep it but stop / start showing it.\n' +
        'Data and design are kept apart, so that a widget looks the same every time it is refreshed. Every part that shows data has a "key": ' +
        'give one that says what it holds, such as {"type":"stat","key":"steps","value":"8,412"}, or it is named after its type ("stat", "text-2"); ' +
        'home_list and the answer to "set" show them. To refresh a widget, "update" it with `values`, ' +
        'which maps a key to the part\'s new data: {"steps":{"value":"9,120","caption":"91% of goal"}} (null clears a field). Data is: text and markdown: ' +
        'text; stat: value, label, unit, caption, icon; fields and list: items; progress and gauge: value, label, caption; chart: values, labels, caption; ' +
        'icon: name; badge: text, icon; button: text, action; image: path; file: path, title, caption; countdown: to, label. Everything else is design. ' +
        '"set" on a widget that is already there is only for when the user asks for a new look or layout.\n' +
        'Size: Home is 4 columns across (on a phone a column is about 80 points wide), and `columns` (1 to 4) is how many a widget spans. ' +
        'Widgets fill Home left to right in order; one that does not fit the rest of a line starts the next, and widgets side by side share a height. ' +
        'Use the size the user asks for; otherwise 4, or 2 for one number or a gauge. Each size holds only so much, and a widget that holds more is refused: ' +
        SIZE_RULES + '\n' +
        'The widget draws only its body: `title` is its name, not a heading. Whether it shows a heading is part of its design — a text part ' +
        'such as {"type":"text","text":"Steps","style":"footnote","weight":"semibold","color":"secondary"} at the top when it helps; a small widget rarely has room.\n' +
        'A body is one object with a "type". Content:\n' +
        '- {"type":"text","text":"…","style":"largeTitle|title|title2|title3|headline|subheadline|body|callout|footnote|caption","weight":"light|regular|medium|semibold|bold|heavy","design":"default|rounded|monospaced","size":34,"lines":2}\n' +
        '- {"type":"markdown","text":"…"}\n' +
        '- {"type":"stat","value":"8,412","label":"Steps","unit":"","caption":"goal 10,000","icon":"figure.walk"}\n' +
        '- {"type":"fields","items":[{"label":"Gate","value":"B12"}]}\n' +
        '- {"type":"list","items":[{"title":"…","subtitle":"…","value":"…","icon":"…","action":{…}}]}\n' +
        '- {"type":"progress","value":0.84,"label":"…"} and {"type":"gauge","value":0.84,"label":"84%","size":72} (a ring); value from 0 to 1\n' +
        '- {"type":"chart","kind":"line|bar|area","values":[1,2,3],"labels":["M","T","W"],"caption":"…"}\n' +
        '- {"type":"icon","name":"airplane","size":28} (an SF Symbol name), {"type":"badge","text":"On time","icon":"checkmark"}\n' +
        '- {"type":"button","text":"Check in","icon":"airplane","variant":"filled|tinted|plain","action":{…}} a button; a tap does its action\n' +
        '- {"type":"countdown","to":"2026-10-12T07:15:00+07:00","label":"until boarding"} (ticks live)\n' +
        '- {"type":"file","path":"Trips/ticket.pdf","title":"Travel ticket"} a file or folder in the user\'s Drive, as a row that opens it; ' +
        '{"type":"image","path":"Trips/map.png","height":160} a picture from Drive.\n' +
        '- {"type":"divider"}, {"type":"spacer"}\n' +
        '- {"type":"table","columns":["Item","Qty"],"rows":[["Lamb","2 kg"]],"caption":"…"}\n' +
        'Interactive parts: each sets a name ("bind") that formulas in the widget read, and starts at its "value": ' +
        '{"type":"stepper","bind":"people","value":4,"min":1,"max":20,"step":1,"label":"People","unit":""}, ' +
        '{"type":"slider","bind":"years","value":10,"min":1,"max":40,"label":"Years"}, {"type":"toggle","bind":"metric","value":true,"label":"Metric"}, ' +
        '{"type":"segmented","bind":"tab","options":["Menu","Shopping","Timeline"]} (tabs), ' +
        '{"type":"checklist","bind":"done","items":[{"title":"Start roasting","detail":"…","time":"13:30"}]} (with times it is a timeline; its name is how many are ticked). ' +
        'What the user sets is saved, on every device, and you are told about it with their next message.\n' +
        'Formulas: any text the widget shows may hold {…}, worked out live: "{round(people * 0.4, 1)} kg", "{done} of 8 done", "{tab == \'Menu\' ? \'…\' : \'…\'}". ' +
        'A progress or gauge "value" may be one too: "{done / 8}". "when":"tab == \'Shopping\'" on any part draws it only while true. ' +
        'Formulas use numbers, \'text\', the names, + - * / %, == != < <= > >=, && || !, c ? a : b, min, max, round(x, digits), floor, ceil, abs, clamp(x, lo, hi), if(c, a, b), fixed(x, digits); ' +
        'a name no input sets goes in "state" on the outermost part: {"type":"stack","state":{"rate":0.05},"children":[…]}. ' +
        'Use them when the answer depends on something the user may change (how many people, an amount, a time span) or has steps to tick off; not for what never changes.\n' +
        'Actions (on a button, a list item or any container): {"type":"open_url","url":"https://…"}, {"type":"open_file","path":"Trips/ticket.pdf"}, ' +
        '{"type":"ask","prompt":"…"} (opens a chat with this ready for the user to send), {"type":"copy","text":"…"} (to the clipboard), ' +
        '{"type":"calendar","title":"…","start":"2026-10-12 19:00","end":"…","place":"…"} (offers it to their calendar). ' +
        'In a card in a chat reply (not on Home) also {"type":"reply","text":"…"}: a tap sends these words as the user\'s message, like a quick reply — ' +
        'for a choice inside the card, or handing what they set back to you ("Remind me at each step", "Book it for {people}"). Words in any action may hold formulas. ' +
        'Pick the one that does what the user asked a tap to do.\n' +
        'Layout: {"type":"stack","children":[…]} one under the other, {"type":"row","children":[…],"valign":"top|center|bottom|baseline"} side by side ' +
        '(equal widths; "fit":true on a child keeps it to its own width), {"type":"grid","columns":2,"children":[…]} tiles, ' +
        '{"type":"layer","children":[…],"anchor":"bottomLeading"} on top of each other, first at the back. All take "spacing".\n' +
        'Style, on any part: "color" (its text, icons and accents, and its children\'s), "background", "gradient":["#0B3D91","#1F6FEB"] with "direction":"down|right|diagonal", ' +
        '"backgroundImage":"Home/rome.jpg" (a Drive picture behind it, cropped to fill; its background or gradient is drawn over the picture), ' +
        '"padding", "corner", "border", "opacity", "align":"leading|center|trailing", "height". Colours: primary, secondary, accent, petal, white, black, gray, red, orange, ' +
        'yellow, green, mint, teal, cyan, blue, indigo, purple, pink, brown, or hex (#RRGGBBAA for see-through). A background, gradient or picture on the body itself fills the whole card.\n' +
        'Pictures come from Drive only, never a web address. Paths are relative to ~/Drive and must exist. A picture the user sent is in Drive (the drivePath given with it); ' +
        'to use one from the web, download it into Drive first (such as Home/rome.jpg) with the shell.\n' +
        'Design it like a native iOS widget, to Apple\'s Human Interface Guidelines:\n' +
        '- Type: the system font only, never serif. Prefer the named styles (they follow the user\'s text size) over "size"; at most three sizes and two weights in a widget. ' +
        'One focal point (the number or line that matters most), the rest smaller and in secondary.\n' +
        '- Room to breathe: spacing on an 8-point grid (8 inside a group, 12 to 16 between groups); "padding" 16 to 20 on any part with a background or picture; ' +
        '"corner" 16 to 22 on cards and smaller on what sits inside them. Nothing touches an edge, and a widget shows a few things well rather than everything.\n' +
        '- Contrast: text must read at a glance (4.5:1). On a gradient or picture set "color":"white" (or a dark colour on a light ground); ' +
        'on a picture also add a scrim, such as "gradient":["#00000000","#000000B3"], and a "height" (160 to 240). Colour with restraint: one accent or one gradient.\n' +
        '- Buttons: a short verb ("Open ticket", "Check in"), at most two in a widget, one "filled" for the main action and "tinted" or "plain" for the other. ' +
        'Icons are SF Symbols.\n' +
        'A simple widget needs no styling at all: bare parts already look like plain iOS.\n' +
        'A widget shows what you wrote until you write it again, so give `hours` to anything that goes stale.',
      inputSchema: z.object({
        action: z.enum(['set', 'update', 'remove', 'move', 'hide', 'show']).default('set'),
        id: z.string().trim().min(1).max(40).describe('A short name: lowercase letters, digits, "-". The same id later means the same widget.'),
        title: z.string().trim().max(80).optional().describe('Its name, used in the app\'s menus and when it is quoted; it is not drawn. A heading the widget should show is a part of its body.'),
        body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe('For "set": the widget, as JSON.'),
        values: z.record(z.string(), z.record(z.string(), z.unknown())).optional()
          .describe('For "update": each key of a part to change, and its new data fields.'),
        columns: z.number().int().min(1).max(4).optional()
          .describe('For "set": how many of Home\'s 4 columns it spans. Leave out to keep an existing widget\'s; a new one is 4.'),
        link: z.url({ protocol: /^https$/ }).optional().describe('For "set": a page a tap on the widget opens.'),
        file: z.string().trim().max(1024).optional().describe('For "set": instead of a link, a file or folder in the user\'s Drive that a tap opens, such as Trips/ticket.pdf.'),
        ask: z.string().trim().max(1000).optional().describe('For "set": instead of a link or file, a message a tap puts in a new chat with you, for the user to send.'),
        hours: z.number().positive().max(8760).optional().describe('For "set" and "update": how long it stays, from now. Leave out for a widget that stays until removed (on "update": to keep it as it was).'),
        before: z.string().trim().max(40).optional().describe('For "set" and "move": the id of the widget it goes above.'),
      }),
      execute: async (input) => {
        switch (input.action) {
          case 'set': {
            if (input.body === undefined) throw new Error('"set" needs a `body`: the widget as JSON, such as {"type":"text","text":"Hello"}.');
            const action: WidgetAction | null = input.link ? { type: 'open_url', url: input.link }
              : input.file ? widgetActionOf({ type: 'open_file', path: input.file })
              : input.ask ? { type: 'ask', prompt: input.ask } : null;
            await requireInDrive(drive, drivePaths({ body: parseWidgetBody(input.body), action }));
            const w = home.set({ id: input.id, title: input.title, body: input.body, action, hours: input.hours, before: input.before, columns: input.columns, source: 'agent' });
            const keys = widgetKeys(w.body);
            return `Home shows "${w.id}" ${w.expiresAt ? `until ${w.expiresAt}` : 'until it is removed'}, ${w.columns === 4 ? 'the full width' : `${w.columns} of 4 columns wide`}` +
              `${w.hidden ? ' — but the user has hidden it; "show" brings it back if they ask' : ''}.` +
              (keys.length ? ` Refresh it with "update" on ${keys.join(', ')}.` : ' It has no keyed parts, so it can only be written again whole.');
          }
          case 'update': {
            if (!input.values) throw new Error('"update" needs `values`: the key of each part to change and its new data, such as {"steps":{"value":"9,120"}}.');
            const current = home.widgets().find((w) => w.id === input.id.trim().toLowerCase());
            if (current) await requireInDrive(drive, drivePaths({ body: applyValues(withKeys(current.body), input.values), action: current.action }));
            const w = home.update({ id: input.id, values: input.values, title: input.title, hours: input.hours, source: 'agent' });
            return `Updated what "${w.id}" shows; its design is unchanged${w.expiresAt ? `, and it stays until ${w.expiresAt}` : ''}.`;
          }
          case 'remove':
            home.remove(input.id);
            return `Removed "${input.id}" from Home.`;
          case 'move':
            home.move(input.id, input.before);
            return `Moved "${input.id}" ${input.before ? `above "${input.before}"` : 'to the end of Home'}.`;
          case 'hide':
          case 'show':
            home.setHidden(input.id, input.action === 'hide');
            return `"${input.id}" is now ${input.action === 'hide' ? 'hidden' : 'shown'} on Home.`;
        }
      },
    }),
    home_list: tool({
      description:
        "Read what is on the Home screen of the user's app now: every widget top to bottom, with its id, how long it " +
        'stays and its body. Use it before changing or moving a widget you did not just write.',
      inputSchema: z.object({}),
      execute: async () => home.widgets().map(describeWidget).join('\n') || 'Home is empty.',
    }),
  };
}
