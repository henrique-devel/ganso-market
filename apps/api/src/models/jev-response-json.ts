/** Parse bounded JSON without silently accepting duplicate/escaped keys.
 * Duplicated routing keys invalidate the batch; malformed data inside a known
 * question remains localized. Ambiguous model/usage invalidates billing too. */
export function parseJevResponseJson(source: string) {
  const value: unknown = JSON.parse(source);
  const tokens = source.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]/g) ?? [];
  const stack: {
    keys: Set<string> | null;
    billing: boolean;
    answerMap: boolean;
    question: string | null;
  }[] = [];
  let ambiguous = false,
    billingAmbiguous = false;
  const invalidQuestions = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "{" || token === "[") {
      const parent = stack.at(-1),
        property =
          tokens[i - 1] === ":" ? (JSON.parse(tokens[i - 2]!) as string) : null;
      stack.push({
        keys: token === "{" ? new Set() : null,
        billing:
          parent?.billing === true ||
          (stack.length === 1 && property === "usage"),
        answerMap: stack.length === 1 && property === "answers",
        question: parent?.answerMap ? property : (parent?.question ?? null),
      });
    } else if (token === "}" || token === "]") stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ":") {
      const frame = stack.at(-1)!,
        key = JSON.parse(token) as string;
      if (frame.keys!.has(key)) {
        if (
          frame.billing ||
          (stack.length === 1 && ["model", "usage"].includes(key))
        ) {
          billingAmbiguous = true;
          ambiguous = true;
        } else if (frame.question !== null)
          invalidQuestions.add(frame.question);
        else ambiguous = true;
      }
      frame.keys!.add(key);
    }
  }
  return {
    value,
    ambiguous,
    billingAmbiguous,
    invalidQuestions: [...invalidQuestions],
  };
}
