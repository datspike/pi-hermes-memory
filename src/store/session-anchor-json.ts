import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { AnchorStringMatcher } from './session-anchor-string-match.js';
import { AnchorMemberMatches } from './session-anchor-members.js';

const TEXT_METADATA = new Set(['type', 'id', 'parentId', 'sessionId', 'session_id', 'timestamp', 'cwd', 'role', 'customType']);
const ROOT_STRINGS = new Set(['type', 'id', 'sessionId', 'session_id', 'timestamp', 'cwd']);
type Role = 'root' | 'session' | 'message' | 'none';
export interface AnchorJsonValue {
  flags: bigint;
  value?: string;
  fields?: Record<string, AnchorJsonValue>;
}
interface Key { identity: string; name?: string }
interface Frame {
  kind: 'object' | 'array';
  role: Role;
  ignoreString: boolean;
  state: 'first' | 'value' | 'key' | 'colon' | 'separator';
  key?: Key;
  flags: bigint;
  members?: AnchorMemberMatches;
  fields?: Record<string, AnchorJsonValue>;
}

class JsonCursor {
  line = 1;
  private readonly decoder = new StringDecoder('utf8');
  private readonly bytes = Buffer.allocUnsafe(64 * 1024);
  private block = '';
  private offset = 0;
  private eof = false;
  constructor(private readonly fd: number, private readonly terms: readonly string[]) {}

  peek(): string | undefined {
    while (this.offset === this.block.length && !this.eof) {
      const read = fs.readSync(this.fd, this.bytes, 0, this.bytes.length, null);
      this.block = read ? this.decoder.write(this.bytes.subarray(0, read)) : this.decoder.end();
      this.offset = 0;
      this.eof = !read;
    }
    return this.block[this.offset];
  }
  next(): string | undefined {
    const char = this.peek();
    if (char !== undefined) { this.offset++; if (char === '\n') this.line++; }
    return char;
  }
  fail(): never { throw new SyntaxError('Invalid JSON'); }
  space(): void { while (this.peek() === ' ' || this.peek() === '\t' || this.peek() === '\r') this.next(); }

  /** Decode a token in bounded blocks; strings used as text are reduced to match bits. */
  string(ignoreString: boolean, capture: boolean, key = false): { flags: bigint; value?: string; key?: Key } {
    if (this.next() !== '"') this.fail();
    const matcher = ignoreString || key ? undefined : new AnchorStringMatcher(this.terms);
    const fragments: Buffer[] = [];
    let bytes = 0;
    let captureBlock: Buffer | undefined;
    let captureOffset = 0;
    const captureText = (text: string): void => {
      bytes += text.length * 2;
      let offset = 0;
      while (offset < text.length) {
        captureBlock ??= Buffer.allocUnsafe(Math.max(1024, Math.min(64 * 1024, text.length * 2)));
        const units = Math.min(text.length - offset, (captureBlock.length - captureOffset) / 2);
        captureBlock.write(text.slice(offset, offset + units), captureOffset, units * 2, 'utf16le');
        offset += units;
        captureOffset += units * 2;
        if (captureOffset === captureBlock.length) { fragments.push(captureBlock); captureBlock = undefined; captureOffset = 0; }
      }
    };
    let name: string | undefined = key ? '' : undefined;
    let hash: ReturnType<typeof createHash> | undefined;
    const consume = (text: string): void => {
      matcher?.feed(text);
      if (capture) captureText(text);
      if (key) {
        if (name !== undefined && name.length + text.length <= 64) name += text;
        else {
          if (!hash) { hash = createHash('sha256'); hash.update(Buffer.from(name!, 'utf16le')); name = undefined; }
          hash.update(Buffer.from(text, 'utf16le'));
        }
      }
    };
    let escaped: string[] = [];
    const flushEscaped = (): void => {
      if (escaped.length) { consume(escaped.join('')); escaped = []; }
    };
    const consumeEscape = (text: string): void => {
      escaped.push(text);
      if (escaped.length === 256) flushEscaped();
    };
    const special = /["\\\u0000-\u001f]/g;
    for (;;) {
      if (this.peek() === undefined) this.fail();
      special.lastIndex = this.offset;
      const match = special.exec(this.block);
      const end = match?.index ?? this.block.length;
      if (end > this.offset) { flushEscaped(); consume(this.block.slice(this.offset, end)); }
      this.offset = end;
      if (!match) continue;
      const char = this.next();
      if (char === '"') break;
      if (char !== '\\') this.fail();
      const escape = this.next();
      const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (escape === 'u') {
        let hex = '';
        for (let i = 0; i < 4; i++) { const digit = this.next(); if (digit === undefined || !/^[\da-f]$/i.test(digit)) this.fail(); hex += digit; }
        consumeEscape(String.fromCharCode(parseInt(hex, 16)));
      } else if (escape !== undefined && Object.hasOwn(simple, escape)) consumeEscape(simple[escape]);
      else this.fail();
    }
    flushEscaped();
    if (captureBlock && captureOffset) fragments.push(captureBlock.subarray(0, captureOffset));
    // Node uses external storage for UTF-16 Buffer strings. Large metadata is
    // not copied into a giant V8 JSON object; the existing output gate checks
    // selected metadata before serialization. Text payloads retain no buffers.
    const value = capture ? Buffer.concat(fragments, bytes).toString('utf16le') : undefined;
    return { flags: matcher?.finish() ?? 0n, value, key: key ? { identity: name === undefined ? 'h:' + hash!.digest('hex') : 's:' + name, name } : undefined };
  }

  number(): void {
    if (this.peek() === '-') this.next();
    if (this.peek() === '0') this.next();
    else { if (!/^[1-9]$/.test(this.peek() ?? '')) this.fail(); this.digits(); }
    if (this.peek() === '.') { this.next(); this.digits(); }
    if (this.peek() === 'e' || this.peek() === 'E') {
      this.next();
      if (this.peek() === '+' || this.peek() === '-') this.next();
      this.digits();
    }
  }
  private digits(): void {
    if (!/^\d$/.test(this.peek() ?? '')) this.fail();
    while (/^\d$/.test(this.peek() ?? '')) this.next();
  }

  parse(): AnchorJsonValue {
    const stack: Frame[] = [];
    let root: AnchorJsonValue | undefined;
    const finish = (value: AnchorJsonValue): void => {
      const parent = stack.at(-1);
      if (!parent) { root = value; return; }
      if (parent.kind === 'array') parent.flags |= value.flags;
      else {
        const key = parent.key!;
        // JSON.parse uses the last property with the decoded key.
        parent.members!.set(key.identity, value.flags);
        if (key.name && this.projected(parent.role, key.name)) parent.fields![key.name] = value;
      }
      parent.state = 'separator';
    };
    const begin = (): void => {
      const parent = stack.at(-1);
      const name = parent?.kind === 'object' ? parent.key?.name : undefined;
      const ignoreString = parent?.kind === 'array' ? parent.ignoreString : name !== undefined && TEXT_METADATA.has(name);
      const role: Role = !parent ? 'root' : parent.role === 'root' && parent.kind === 'object' && (name === 'session' || name === 'message') ? name : 'none';
      const capture = !!parent && parent.kind === 'object' && name !== undefined && this.stringField(parent.role, name);
      const char = this.peek();
      if (char === '{' || char === '[') {
        this.next();
        const object = char === '{';
        stack.push({ kind: object ? 'object' : 'array', role: object ? role : 'none', ignoreString, state: 'first', flags: 0n, members: object ? new AnchorMemberMatches(this.terms.length) : undefined, fields: object ? Object.create(null) : undefined });
      } else if (char === '"') finish(this.string(ignoreString, capture));
      else if (char === '-' || /^[\d]$/.test(char ?? '')) { this.number(); finish({ flags: 0n }); }
      else {
        const literal = char === 't' ? 'true' : char === 'f' ? 'false' : char === 'n' ? 'null' : undefined;
        if (!literal) this.fail();
        for (const expected of literal) if (this.next() !== expected) this.fail();
        finish({ flags: 0n });
      }
    };
    begin();
    while (!root) {
      const frame = stack.at(-1)!;
      this.space();
      const char = this.peek();
      const close = frame.kind === 'object' ? '}' : ']';
      if ((frame.state === 'first' || frame.state === 'separator') && char === close) {
        this.next();
        stack.pop();
        if (frame.members) frame.flags = frame.members.flags;
        finish({ flags: frame.flags, fields: frame.fields });
      } else if (frame.state === 'separator') {
        if (this.next() !== ',') this.fail();
        frame.state = frame.kind === 'object' ? 'key' : 'value';
      } else if (frame.kind === 'object' && (frame.state === 'first' || frame.state === 'key')) {
        if (char !== '"') this.fail();
        frame.key = this.string(true, false, true).key;
        frame.state = 'colon';
      } else if (frame.state === 'colon') {
        if (this.next() !== ':') this.fail();
        frame.state = 'value';
      } else { begin(); }
    }
    this.space();
    if (this.peek() !== undefined && this.peek() !== '\n') this.fail();
    return root;
  }

  private stringField(role: Role, name: string): boolean {
    return role === 'root' ? ROOT_STRINGS.has(name) : role === 'session' ? name === 'id' || name === 'cwd' : role === 'message' && name === 'timestamp';
  }
  private projected(role: Role, name: string): boolean {
    return this.stringField(role, name) || role === 'root' && (name === 'session' || name === 'message');
  }
}

/** Yield nonblank physical lines lazily so the existing line cap runs before JSON validation. */
export function* readAnchorJson(filePath: string, terms: readonly string[]): Generator<{ line: number; parse: () => AnchorJsonValue }> {
  const fd = fs.openSync(filePath, 'r');
  try {
    const cursor = new JsonCursor(fd, terms);
    for (;;) {
      const line = cursor.line;
      let invalidWhitespace = false;
      while (cursor.peek() !== undefined && cursor.peek() !== '\n' && cursor.peek()!.trim() === '') {
        const char = cursor.next();
        invalidWhitespace ||= char !== ' ' && char !== '\t' && char !== '\r';
      }
      if (cursor.peek() === undefined) return;
      if (cursor.peek() === '\n') { cursor.next(); continue; }
      yield { line, parse: () => { if (invalidWhitespace) cursor.fail(); return cursor.parse(); } };
      if (cursor.peek() === '\n') cursor.next();
      else if (cursor.peek() === undefined) return;
      else cursor.fail();
    }
  } finally { fs.closeSync(fd); }
}
