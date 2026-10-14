const STOPWORDS: ReadonlySet<string> = new Set([
  "que", "como", "para", "por", "con", "una", "uno", "las", "los", "del", "de", "la", "el", "en",
  "tu", "tus", "su", "sus", "eres", "ser", "está", "esta", "the", "and", "for", "you", "your",
  "are", "what", "why", "how", "our", "this", "that", "with", "tell", "about", "please"
]);

export function normalizeText(value: string): string {
  return value.toLocaleLowerCase("es")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ").trim();
}

/** Conjunto de tokens significativos. Se calcula UNA vez por texto y se reutiliza. */
export function tokenize(value: string): ReadonlySet<string> {
  return new Set(normalizeText(value).split(" ").filter(token => token.length > 2 && !STOPWORDS.has(token)));
}

/** Índice de Jaccard entre dos conjuntos de tokens ya calculados. */
export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (!left.size || !right.size) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let common = 0;
  for (const token of small) if (large.has(token)) common++;
  return common / (left.size + right.size - common);
}

export function similarity(a: string, b: string): number {
  return jaccard(tokenize(a), tokenize(b));
}
