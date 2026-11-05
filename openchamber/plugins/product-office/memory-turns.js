// memory-turns.js — reconstruction of conversation turns from an OpenChamber
// session page. A "turn" is one user request paired with the assistant's
// answer for THAT request; the pairing never reaches past the next user
// message (which would misattribute answers to earlier requests).
//
// Turn rules (see memory-turns.test.mjs for the full matrix):
//   - a turn opens at the first user message of a run of consecutive user
//     messages (queued prompts belong to the turn they were asked in);
//   - the turn's reply is the assistant message(s) with text content between
//     that run and the next user message: the first one sets the reply, any
//     further ones append (tool continuations and step summaries);
//   - assistant messages carrying only tool parts are ignored, so a
//     tool-only assistant message never closes a turn;
//   - a user message that never receives an answer within its boundaries is
//     left uncaptured (interrupted execution), never paired with a later
//     turn's reply.
export function textOf(message) {
  if (!message) return "";
  if (typeof message.text === "string") return message.text;
  if (Array.isArray(message.content)) {
    return message.content
      .filter(p => p?.type === "text" && typeof p.text === "string")
      .map(p => p.text)
      .join("\n");
  }
  return "";
}

export function buildTurns(messages) {
  const turns = [];
  let open = null;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const type = message?.type;
    if (type === "user") {
      const text = textOf(message).trim();
      if (!text) continue; // synthetic/empty trigger, never a turn boundary
      if (open) {
        if (open.reply) {
          turns.push(open);
          open = null;
        } else {
          // No answer yet: this user message joins the still-open turn.
          open.text = open.text + "\n\n" + text;
          open.endIndex = index;
          open.userIds.push(message.id);
          continue;
        }
      }
      open = { text, reply: "", startIndex: index, endIndex: index, userIds: [message.id], replyEndIndex: null };
      continue;
    }
    if (type === "assistant") {
      const text = textOf(message).trim();
      if (!open) continue; // assistant output before the first user prompt
      if (!text) continue; // tool-only continuation: leave the turn open
      if (open.reply) {
        open.reply = open.reply + "\n\n" + text;
        open.endIndex = index;
      } else {
        open.reply = text;
        open.endIndex = index;
        open.replyEndIndex = index;
      }
    }
  }
  if (open && open.reply) turns.push(open);
  return turns;
}

/** Absolute (session page) index of the last message that belongs to a closed turn. */
export function processedThrough(turns, offset) {
  let through = offset;
  for (const turn of turns) through = Math.max(through, turn.endIndex + 1);
  return through;
}
