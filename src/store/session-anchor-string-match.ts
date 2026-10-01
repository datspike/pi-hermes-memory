const DEFAULT_LOCALE = new Intl.DateTimeFormat().resolvedOptions().locale;
const CASED = /\p{Cased}/u;
const IGNORABLE = /\p{Case_Ignorable}/u;

class MatchState {
  seen = 0n;
  tail = '';
  constructor(readonly terms: readonly string[], readonly overlap: number) {}
  clone(): MatchState {
    const copy = new MatchState(this.terms, this.overlap);
    copy.seen = this.seen;
    copy.tail = this.tail;
    return copy;
  }
  feed(text: string): void {
    const window = this.tail + text;
    for (let i = 0; i < this.terms.length; i++) {
      const bit = 1n << BigInt(i);
      if (!(this.seen & bit) && window.includes(this.terms[i])) this.seen |= bit;
    }
    // Copy the suffix: a slice can otherwise pin the complete decoded block.
    this.tail = Buffer.from(window.slice(-this.overlap || window.length), 'utf16le').toString('utf16le');
  }
}

type Pending = { kind: 'sigma' | 'turkic' | 'above'; yes: MatchState; no: MatchState };

/** Match the original locale-lowered UTF-16 substrings without retaining the source string. */
export class AnchorStringMatcher {
  private state: MatchState;
  private pending?: Pending;
  private highSurrogate = '';
  private precedingCased = false;
  private readonly language: string;
  private readonly special: RegExp;
  private readonly specialChars: string[];
  private readonly combiningClasses = new Map<string, 0 | 1 | 230>();
  private readonly contextMarks = new Set<string>();
  private contextRun?: RegExp;
  private readonly all: bigint;

  constructor(readonly terms: readonly string[], readonly locale = DEFAULT_LOCALE) {
    this.state = new MatchState(terms, terms.reduce((max, term) => Math.max(max, term.length - 1), 0));
    this.language = locale.split('-')[0].toLowerCase();
    this.specialChars = this.language === 'tr' || this.language === 'az' ? ['Σ', 'I'] : this.language === 'lt' ? ['Σ', 'I', 'J', 'Į'] : ['Σ'];
    this.special = new RegExp(`[${this.specialChars.join('')}]`, 'u');
    this.all = (1n << BigInt(terms.length)) - 1n;
  }

  feed(text: string): void {
    if (this.state.seen === this.all && !this.pending) return;
    text = this.highSurrogate + text;
    this.highSurrogate = '';
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      this.highSurrogate = text.slice(-1);
      text = text.slice(0, -1);
    }
    this.consume(text);
  }

  finish(): bigint {
    if (this.highSurrogate) this.consume(this.highSurrogate);
    if (this.pending) {
      // End of string supplies no following cased letter, dot, or above accent.
      this.state = this.pending.kind === 'sigma' ? this.pending.yes : this.pending.no;
      this.pending = undefined;
    }
    return this.state.seen;
  }

  private updateCased(text: string): void {
    for (let i = text.length; i > 0;) {
      let start = i - 1;
      const low = text.charCodeAt(start);
      if (low >= 0xdc00 && low <= 0xdfff && start > 0) {
        const high = text.charCodeAt(start - 1);
        if (high >= 0xd800 && high <= 0xdbff) start--;
      }
      const char = text.slice(start, i);
      i = start;
      if (!IGNORABLE.test(char)) { this.precedingCased = CASED.test(char); break; }
    }
  }

  private consume(text: string): void {
    let offset = 0;
    while (offset < text.length) {
      if (this.state.seen === this.all && !this.pending) return;
      if (this.pending) {
        // Context can cross arbitrarily long runs of ignorable characters.
        // Feed both alternatives in blocks rather than allocating per scalar.
        let end = offset;
        if (this.pending.kind === 'sigma') {
          const stop = text.slice(offset).search(/[^\p{Case_Ignorable}]/u);
          end = stop < 0 ? text.length : offset + stop;
        } else if (this.contextRun) {
          this.contextRun.lastIndex = offset;
          const run = this.contextRun.exec(text);
          if (run) end += run[0].length;
        }
        if (end > offset) {
          const lower = this.lower(text.slice(offset, end));
          this.pending.yes.feed(lower);
          this.pending.no.feed(lower);
          offset = end;
          continue;
        }
        const char = String.fromCodePoint(text.codePointAt(offset)!);
        const decision = this.decision(char);
        if (decision !== undefined) {
          const pending = this.pending;
          this.state = decision ? pending.yes : pending.no;
          this.pending = undefined;
          // Turkic I + dot becomes i; the contextual dot itself disappears.
          if (pending.kind === 'turkic' && char === '\u0307') {
            offset += char.length;
            this.precedingCased = true;
            continue;
          }
          continue;
        }
        if (this.pending.kind !== 'sigma' && !this.contextMarks.has(char)) {
          this.contextMarks.add(char);
          this.contextRun = new RegExp(`[${[...this.contextMarks].map(mark => `\\u{${mark.codePointAt(0)!.toString(16)}}`).join('')}]+`, 'uy');
        }
        const lower = this.lower(char);
        this.pending.yes.feed(lower);
        this.pending.no.feed(lower);
        offset += char.length;
        continue;
      }
      const rest = text.slice(offset);
      const index = rest.search(this.special);
      const last = Math.max(...this.specialChars.map(char => rest.lastIndexOf(char)));
      if (index >= 0 && last > index) {
        // Every earlier conditional base has a following known cased/CCC-0
        // base in this block. Native casing can handle that entire prefix;
        // only the last base needs unresolved lookahead across blocks.
        const span = rest.slice(0, last);
        this.state.feed(this.lower((this.precedingCased ? 'A' : ' ') + span + 'A').slice(1, -1));
        this.updateCased(span);
        offset += last;
        continue;
      }
      const end = index < 0 ? text.length : offset + index;
      if (end > offset) {
        const ordinary = text.slice(offset, end);
        this.state.feed(this.lower(ordinary));
        // Only case-ignorable characters can carry sigma's preceding context.
        this.updateCased(ordinary);
        offset = end;
      }
      if (offset === text.length) break;
      const char = text[offset++];
      if (char === 'Σ' && !this.precedingCased) {
        this.state.feed('σ');
      } else {
        const kind = char === 'Σ' ? 'sigma' : this.language === 'lt' ? 'above' : 'turkic';
        const yes = this.state.clone();
        const no = this.state.clone();
        if (kind === 'sigma') { yes.feed('ς'); no.feed('σ'); }
        else if (kind === 'turkic') { yes.feed('i'); no.feed('ı'); }
        else { const lower = this.lower(char); yes.feed(lower + '\u0307'); no.feed(lower); }
        this.pending = { kind, yes, no };
      }
      this.precedingCased = true;
    }
  }

  private lower(text: string): string {
    return this.locale === DEFAULT_LOCALE ? text.toLocaleLowerCase() : text.toLocaleLowerCase(this.locale);
  }

  private decision(char: string): boolean | undefined {
    if (this.pending!.kind === 'sigma') {
      if (IGNORABLE.test(char)) return undefined;
      return !CASED.test(char);
    }
    if (this.pending!.kind === 'turkic' && char === '\u0307') return true;
    const ccc = this.combiningClass(char);
    if (this.pending!.kind === 'above' && ccc === 230) return true;
    if (ccc === 0 || ccc === 230) return false;
    return undefined;
  }

  private combiningClass(char: string): 0 | 1 | 230 {
    const cached = this.combiningClasses.get(char);
    if (cached !== undefined) return cached;
    // Native SpecialCasing supplies these two predicates without a vendored
    // Unicode table: More_Above identifies CCC 230, Before_Dot stops at 0/230.
    const above = ('I' + char).toLocaleLowerCase('lt').startsWith('i\u0307');
    const blocksDot = ('I' + char + '\u0307').toLocaleLowerCase('tr').startsWith('ı');
    const value = above ? 230 : blocksDot ? 0 : 1;
    this.combiningClasses.set(char, value);
    return value;
  }
}
