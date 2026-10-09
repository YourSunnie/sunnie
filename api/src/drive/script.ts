/** Runs on the computer, never in the server process. Paths are opened relative to directory
 * descriptors without following symlinks; a string prefix check alone is not a boundary. */
export const DRIVE_SCRIPT = String.raw`
import base64, ctypes, datetime, errno, hashlib, json, mimetypes, os, shutil, stat, sys, uuid

MAX_FILE = 20 * 1024 * 1024
MAX_TEXT = 256 * 1024
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

class DriveError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message

def fail(status, message):
    raise DriveError(status, message)

def components(path, root_allowed=False):
    if not isinstance(path, str) or len(path.encode('utf-8')) > 4096:
        fail(400, 'Use a Drive-relative path of at most 4096 bytes.')
    if path == '' and root_allowed:
        return []
    parts = path.split('/')
    if any(p in ('', '.', '..') or len(p.encode('utf-8')) > 255 for p in parts) or any(ord(c) < 32 or ord(c) == 127 or c == '\\' for c in path):
        fail(400, 'Use a relative Drive path without empty, dot, or parent segments.')
    return parts

def directory(parent, name, create=False):
    if create:
        try: os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError: pass
    return os.open(name, DIRECTORY, dir_fd=parent)

def descend(root, parts, create=False):
    current = os.dup(root)
    try:
        for part in parts:
            child = directory(current, part, create)
            os.close(current)
            current = child
        return current
    except:
        os.close(current)
        raise

def revision(s):
    return hashlib.sha256((':'.join(str(v) for v in (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns))).encode()).hexdigest()

def metadata(path, s):
    kind = 'directory' if stat.S_ISDIR(s.st_mode) else 'file' if stat.S_ISREG(s.st_mode) and s.st_nlink == 1 else 'unsupported'
    return dict(path=path, name=path.rsplit('/', 1)[-1] or 'Drive', kind=kind,
                sizeBytes=s.st_size if kind == 'file' else 0,
                modifiedAt=datetime.datetime.fromtimestamp(s.st_mtime, datetime.timezone.utc).isoformat(),
                revision=revision(s), mediaType=mimetypes.guess_type(path)[0] or 'application/octet-stream')

def info(parent, name):
    s = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if not stat.S_ISDIR(s.st_mode) and not (stat.S_ISREG(s.st_mode) and s.st_nlink == 1):
        fail(400, 'Drive supports regular files and folders, not links or special files.')
    return s

def unchanged(parent, name, expected):
    s = info(parent, name)
    if revision(s) != expected:
        fail(409, 'This item changed. Refresh it before trying again; your changes were not saved.')
    return s

def read_file(parent, name, maximum):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    with os.fdopen(fd, 'rb') as f:
        before = os.fstat(f.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            fail(400, 'Only regular files without hard links can be opened.')
        if before.st_size > maximum:
            fail(413, 'This file exceeds the ' + str(maximum) + '-byte limit for this operation.')
        data = f.read(maximum + 1)
        if len(data) > maximum:
            fail(413, 'This file exceeds the size limit for this operation.')
        if revision(before) != revision(os.fstat(f.fileno())):
            fail(409, 'This file changed while being read. Open it again.')
    return data, before

def text_content(data):
    try: value = data.decode('utf-8')
    except UnicodeDecodeError: fail(400, 'The editor supports UTF-8 text. Download this file to edit it in another app.')
    if any(ord(c) < 32 and c not in '\r\n\t' for c in value):
        fail(400, 'This is not a plain-text file. Use Preview or Download instead.')
    return value

def move_exclusive(parent, name, destination_parent, destination):
    # Native no-replace renames close the check-then-rename overwrite race with shell tools.
    libc = ctypes.CDLL(None, use_errno=True)
    function = getattr(libc, 'renameatx_np' if sys.platform == 'darwin' else 'renameat2', None)
    if function is None:
        fail(502, 'This computer does not support safe exclusive moves.')
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(parent, os.fsencode(name), destination_parent, os.fsencode(destination), 4 if sys.platform == 'darwin' else 1) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))

def write_file(parent, name, data, expected=None):
    if len(data) > MAX_FILE:
        fail(413, 'A Drive upload may be at most 20 MiB.')
    temporary = '.sunnie-write-' + uuid.uuid4().hex
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if expected is None:
            move_exclusive(parent, temporary, parent, name)
        else:
            unchanged(parent, name, expected)
            os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
    finally:
        try: os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError: pass

def run(request):
    home = os.open(request['workspace'], DIRECTORY)
    try: root = directory(home, 'Drive', True)
    finally: os.close(home)
    try:
        action, path = request['action'], request['path']
        parts = components(path, action in ('list', 'stat'))
        if action == 'list':
            folder = descend(root, parts)
            try:
                # Bound even directory enumeration; no recursive walk or whole-drive index.
                names = []
                with os.scandir(folder) as items:
                    for item in items:
                        if len(names) >= 10000:
                            fail(413, 'This folder has over 10,000 entries. Organize it into smaller folders with Sunnie.')
                        names.append(item.name)
                names.sort(key=lambda name: (name.casefold(), name))
                offset = request['offset']
                entries = []
                for name in names[offset:offset + 200]:
                    try:
                        child_path = '/'.join(parts + [name])
                        components(child_path)
                        entries.append(metadata(child_path, os.stat(name, dir_fd=folder, follow_symlinks=False)))
                    except FileNotFoundError: pass
                    except (DriveError, UnicodeError): pass
                return dict(path=path, entries=entries, nextOffset=offset + 200 if len(names) > offset + 200 else None)
            finally: os.close(folder)
        if not parts:
            return metadata('', os.fstat(root))
        parent = descend(root, parts[:-1], action == 'import')
        name = parts[-1]
        try:
            if action == 'stat': return metadata(path, info(parent, name))
            if action in ('read', 'text'):
                data, s = read_file(parent, name, MAX_TEXT if action == 'text' else MAX_FILE)
                result = dict(entry=metadata(path, s))
                result['text' if action == 'text' else 'data'] = text_content(data) if action == 'text' else base64.b64encode(data).decode('ascii')
                return result
            if action == 'mkdir':
                os.mkdir(name, 0o700, dir_fd=parent)
            elif action in ('upload', 'import'):
                data = base64.b64decode(request['data'], validate=True)
                if action == 'import':
                    try:
                        info(parent, name)
                        return metadata(path, info(parent, name))
                    except FileNotFoundError: pass
                write_file(parent, name, data)
            elif action == 'write':
                data = request['text'].encode('utf-8')
                if len(data) > MAX_TEXT: fail(413, 'The text editor supports files up to 256 KiB.')
                text_content(data)
                current, s = read_file(parent, name, MAX_TEXT)
                text_content(current)
                unchanged(parent, name, request['revision'])
                write_file(parent, name, data, request['revision'])
            elif action == 'move':
                destination = components(request['destination'])
                unchanged(parent, name, request['revision'])
                if destination == parts or destination[:len(parts)] == parts:
                    fail(400, 'Choose a different location outside this folder.')
                target = descend(root, destination[:-1])
                try: move_exclusive(parent, name, target, destination[-1])
                finally: os.close(target)
                return dict(path=request['destination'])
            elif action == 'delete':
                s = unchanged(parent, name, request['revision'])
                if stat.S_ISDIR(s.st_mode):
                    if not shutil.rmtree.avoids_symlink_attacks:
                        fail(502, 'Safe folder deletion is not supported on this computer.')
                    shutil.rmtree(name, dir_fd=parent)
                else: os.unlink(name, dir_fd=parent)
                return dict(ok=True)
            else: fail(400, 'Unknown Drive operation.')
            return metadata(path, info(parent, name))
        finally: os.close(parent)
    finally: os.close(root)

try:
    result = run(json.load(sys.stdin))
    print(json.dumps(dict(ok=True, result=result), ensure_ascii=False))
except DriveError as error:
    print(json.dumps(dict(ok=False, status=error.status, error=error.message)))
except OSError as error:
    status, message = 502, 'Drive could not complete the operation. Refresh the folder before trying again.'
    if error.errno == errno.ENOENT: status, message = 404, 'This Drive item no longer exists. It may have been moved or deleted.'
    elif error.errno in (errno.EEXIST, errno.ENOTEMPTY): status, message = 409, 'An item already exists at the destination. Choose another name.'
    elif error.errno in (errno.ELOOP, errno.ENOTDIR, errno.EISDIR, errno.EINVAL): status, message = 400, 'That path is not a supported Drive file or folder. Links are not followed.'
    elif error.errno in (errno.EACCES, errno.EPERM): status, message = 400, 'Sunnie does not have permission to access this item.'
    print(json.dumps(dict(ok=False, status=status, error=message)))
except Exception:
    print(json.dumps(dict(ok=False, status=502, error='The Drive command failed. Check Python 3 on the computer and refresh before retrying.')))
`;
