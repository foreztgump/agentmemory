import type { EvalCase } from "./score.js";
import { mulberry32, pickWeighted, sampleQuantile } from "./stats.js";

export interface Profile {
  observations: number;
  indexable: number;
  types: Record<string, number>;
  hookTypes: Record<string, { count: number; originalBytes: number[] }>;
  jsonBytes: { quantiles: number[] };
  indexed: {
    titleLength: number[];
    narrativeLength: number[];
    files: Record<string, number>;
    vocabulary: number;
  };
  withSubtitle: number;
  observationsPerSession: number[];
}

export interface Observation {
  id: string;
  sessionId: string;
  timestamp: string;
  type: string;
  title: string;
  subtitle?: string;
  narrative: string;
  facts: string[];
  concepts: string[];
  files: string[];
  importance: number;
  confidence: number;
  source: Record<string, unknown>;
}

export interface Session {
  id: string;
  project: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  updatedAt: string;
  status: "completed";
  observationCount: number;
}

const START_MS = Date.parse("2026-09-17T00:00:00.000Z");
const SPAN_MS = 60 * 24 * 3600 * 1000;
const CONSONANTS = "bcdfghjklmnprstvwz";
const VOWELS = "aeiou";
const PROJECTS = 38;
const FILLER = "payload filler for byte size ";

export function pseudoWord(n: number): string {
  let word = "";
  let x = n + 1;
  do {
    word += CONSONANTS[x % CONSONANTS.length] + VOWELS[Math.floor(x / CONSONANTS.length) % VOWELS.length];
    x = Math.floor(x / (CONSONANTS.length * VOWELS.length));
  } while (x > 0);
  return word.length < 4 ? word + "n" : word;
}

// Planted words contain "q" and "x", which pseudoWord never emits, so they occur
// only where the generator plants them.
export function plantedWord(n: number): string {
  return `q${pseudoWord(n)}x`;
}

function randomId(prefix: string, ms: number, rand: () => number): string {
  let tail = "";
  for (let i = 0; i < 12; i++) tail += Math.floor(rand() * 16).toString(16);
  return `${prefix}_${ms.toString(36)}_${tail}`;
}

export class Corpus {
  private readonly cdf: Float64Array;
  constructor(readonly vocabulary: number) {
    this.cdf = new Float64Array(vocabulary);
    let sum = 0;
    for (let r = 0; r < vocabulary; r++) {
      sum += 1 / (r + 1);
      this.cdf[r] = sum;
    }
    for (let r = 0; r < vocabulary; r++) this.cdf[r] /= sum;
  }

  word(u: number): string {
    let lo = 0;
    let hi = this.vocabulary - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cdf[mid] < u) lo = mid + 1;
      else hi = mid;
    }
    return pseudoWord(lo);
  }

  text(length: number, rand: () => number): string {
    let out = "";
    while (out.length < length) out += (out ? " " : "") + this.word(rand());
    return out.slice(0, Math.max(0, Math.round(length)));
  }
}

// Vocabulary grows with corpus size; Heaps' law with beta 0.5 from the profile's measured point.
export function vocabularyFor(profile: Profile, observations: number): number {
  return Math.max(1000, Math.round(profile.indexed.vocabulary * Math.sqrt(observations / profile.indexable)));
}

export class Generator {
  private readonly rand: () => number;
  private readonly corpus: Corpus;
  private readonly fileShare: number;
  private readonly indexableShare: number;
  private readonly subtitleShare: number;
  private readonly hookWeights: Record<string, number>;
  private readonly typeWeights: Record<string, number>;

  constructor(private readonly profile: Profile, observations: number, seed: number) {
    this.rand = mulberry32(seed);
    this.corpus = new Corpus(vocabularyFor(profile, observations));
    const files = profile.indexed.files;
    const total = Object.values(files).reduce((a, b) => a + b, 0);
    this.fileShare = total ? 1 - (files["0-0"] ?? 0) / total : 0;
    this.indexableShare = profile.indexable / profile.observations;
    this.subtitleShare = profile.withSubtitle / profile.observations;
    this.hookWeights = Object.fromEntries(Object.entries(profile.hookTypes).map(([k, v]) => [k, v.count]));
    this.typeWeights = Object.fromEntries(Object.entries(profile.types).filter(([k]) => k !== "none"));
  }

  session(index: number): Session {
    const ms = START_MS + Math.floor(this.rand() * SPAN_MS);
    const id = randomId("ses", ms, this.rand);
    const iso = new Date(ms).toISOString();
    const project = `synthetic-project-${index % PROJECTS}`;
    return { id, project, cwd: `/work/${project}`, startedAt: iso, updatedAt: iso, endedAt: iso, status: "completed", observationCount: 0 };
  }

  sessionSize(): number {
    return Math.max(1, Math.round(sampleQuantile(this.profile.observationsPerSession, this.rand())));
  }

  observation(session: Session, offsetMs: number, text: { narrative?: string; title?: string; concepts?: string[]; files?: string[] } = {}): Observation {
    const ms = Date.parse(session.startedAt) + offsetMs;
    const indexable = text.narrative !== undefined || this.rand() < this.indexableShare;
    const hookType = pickWeighted(this.hookWeights, this.rand());
    const type = indexable ? pickWeighted(this.typeWeights, this.rand()) : "other";
    const q = this.profile.indexed;
    const title = text.title ?? this.corpus.text(Math.max(4, sampleQuantile(q.titleLength, this.rand())), this.rand);
    const narrative = text.narrative ?? (indexable ? this.corpus.text(sampleQuantile(q.narrativeLength, this.rand()), this.rand) : "");
    const files = text.files ?? (this.rand() < this.fileShare ? [`src/${this.corpus.word(this.rand())}/${this.corpus.word(this.rand())}.ts`] : []);
    const obs: Observation = {
      id: randomId("obs", ms, this.rand),
      sessionId: session.id,
      timestamp: new Date(ms).toISOString(),
      type,
      title,
      ...(this.rand() < this.subtitleShare ? { subtitle: this.corpus.text(60, this.rand) } : {}),
      narrative,
      facts: [],
      concepts: text.concepts ?? [],
      files,
      importance: 5,
      confidence: 0.3,
      source: { hookType, originalBytes: 0, truncated: false, payload: "" },
    };
    const target = sampleQuantile(this.profile.jsonBytes.quantiles, this.rand());
    const missing = Math.round(target - Buffer.byteLength(JSON.stringify(obs)));
    // The payload is not indexed, so filler only has to take up the measured bytes.
    if (missing > 0) obs.source.payload = FILLER.repeat(Math.ceil(missing / FILLER.length)).slice(0, missing);
    obs.source.originalBytes = Buffer.byteLength(String(obs.source.payload));
    return obs;
  }

  word(): string {
    return this.corpus.word(this.rand());
  }

  commonText(length: number): string {
    return this.corpus.text(length, this.rand);
  }
}

export interface Planted {
  sessions: Session[];
  observations: Observation[];
  graphSeeds: Observation[][];
  cases: EvalCase[];
}

// Facts the recall eval asks about. Keyword cases plant three unique words in a
// target observation and one of them in each of three distractors; the query
// names two of the three. Graph cases link an entity to a file through one
// observation and put a second observation on the same file without the entity,
// so the second is reachable from the entity only through the graph edge.
export function plant(gen: Generator, keywordCases = 40, graphCases = 10): Planted {
  const sessions: Session[] = [];
  const observations: Observation[] = [];
  const graphSeeds: Observation[][] = [];
  const cases: EvalCase[] = [];
  let next = 0;
  const unique = () => plantedWord(next++);
  for (let i = 0; i < keywordCases; i++) {
    const session = gen.session(i);
    const words = [unique(), unique(), unique()];
    const target = gen.observation(session, 1000, { narrative: `${gen.commonText(120)} ${words.join(" ")} ${gen.commonText(120)}` });
    const distractors = words.map((w, k) => gen.observation(session, 2000 + k * 1000, { narrative: `${gen.commonText(150)} ${w} ${gen.commonText(100)}` }));
    session.observationCount = 4;
    sessions.push(session);
    observations.push(target, ...distractors);
    cases.push({ id: `kw-${String(i + 1).padStart(2, "0")}`, kind: "keyword", query: `${gen.word()} ${words[1]} ${words[0]} ${gen.word()}`, expected: [target.id] });
  }
  for (let i = 0; i < graphCases; i++) {
    const session = gen.session(keywordCases + i);
    const entity = unique();
    const name = entity[0].toUpperCase() + entity.slice(1);
    const file = `src/${unique()}/${unique()}.ts`;
    const anchor = gen.observation(session, 1000, { narrative: gen.commonText(200), concepts: [name], files: [file] });
    const hidden = gen.observation(session, 2000, { narrative: gen.commonText(200), concepts: [], files: [file] });
    session.observationCount = 2;
    sessions.push(session);
    observations.push(anchor, hidden);
    graphSeeds.push([anchor, hidden]);
    cases.push({ id: `graph-${String(i + 1).padStart(2, "0")}`, kind: "graph", query: `"${name}"`, expected: [hidden.id] });
  }
  return { sessions, observations, graphSeeds, cases };
}

export function obsIndexShard(obsId: string): number {
  let hash = 5381;
  for (let i = 0; i < obsId.length; i++) hash = ((hash << 5) + hash + obsId.charCodeAt(i)) | 0;
  return Math.abs(hash) % 64;
}

export function resp(args: string[]): string {
  let out = `*${args.length}\r\n`;
  for (const a of args) out += `$${Buffer.byteLength(a)}\r\n${a}\r\n`;
  return out;
}
