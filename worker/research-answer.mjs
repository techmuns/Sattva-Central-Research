// Muns exposes a single text channel, including provider draft narration. Only
// an explicitly framed final answer may reach the customer. EOF is not proof
// of completion: a token-limited answer must remain visibly incomplete.
export const ANSWER_OPEN = '<research-answer>';
export const ANSWER_CLOSE = '</research-answer>';
export function finalAnswerFilter(emit) {
  let buffer = '', started = false, ended = false, visible = false;
  const write = text => { if (!visible) text = text.replace(/^\s+/, ''); if (text) { visible ||= !!text.trim(); emit(text); } };
  return {
    push(text) {
      if (ended) return;
      buffer += text;
      if (!started) {
        // The provider concatenates draft and final channels without inserting
        // a newline, even when the final channel starts with our marker.
        const match = /<research-answer>\s*/.exec(buffer);
        if (!match) {
          if (buffer.length > 24_000) throw new Error('The provider did not produce a final answer within its limit.');
          return;
        }
        buffer = buffer.slice(match.index + match[0].length);
        started = true;
      }
      const closing = buffer.indexOf(ANSWER_CLOSE);
      if (closing >= 0) { write(buffer.slice(0, closing)); buffer = ''; ended = true; return; }
      // Retain only a possible split closing tag; ordinary tokens stream now.
      let keep = Math.min(buffer.length, ANSWER_CLOSE.length - 1);
      while (keep && !ANSWER_CLOSE.startsWith(buffer.slice(-keep))) keep--;
      write(buffer.slice(0, buffer.length - keep));
      buffer = buffer.slice(buffer.length - keep);
    },
    finish() {
      return { started, complete: ended && visible, visible };
    },
  };
}
