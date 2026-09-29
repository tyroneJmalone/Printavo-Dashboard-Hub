export type EmailBodySegment = {
  kind: "message" | "signature" | "quote";
  text: string;
};

// Deliberately line-anchored: ordinary prose mentioning "wrote" or "From" is not a reply.
const gmailReply = /^On .{0,240}(?:\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b|\b\d{1,4}[/-]\d{1,2}\b|\b\d{4}\b).{0,240} wrote:\s*$/i;
const originalMessage = /^-{2,}\s*Original Message\s*-{2,}\s*$/i;
const outlookField = /^(From|Sent|Date|To|Cc|Subject):\s*\S/i;
const signoff = /^(?:best(?: regards)?|kind regards|regards|thanks(?: again)?|thank you|cheers|sincerely)[!,.\s]*$/i;
const mintBrand = /^(?:the )?Mint Printworks[™®]?\s*$/i;

/**
 * Adds only visual boundaries. Slicing at original character offsets keeps every byte
 * (including blank lines and CRLF) in order; uncertain text stays in the message.
 */
export function segmentEmailBody(body: string): EmailBodySegment[] {
  if (!body) return [];
  const lines: { start: number; text: string }[] = [];
  let start = 0;
  for (const match of body.matchAll(/\r?\n/g)) {
    lines.push({ start, text: body.slice(start, match.index) });
    start = match.index + match[0].length;
  }
  lines.push({ start, text: body.slice(start) });

  const isOutlookHeader = (index: number) => {
    if (!/^From:\s*\S/i.test(lines[index].text.trim())) return false;
    const fields = new Set<string>();
    for (let j = index; j < Math.min(lines.length, index + 7); j++) {
      const line = lines[j].text.trim();
      if (!line) break;
      const field = outlookField.exec(line);
      if (!field) break;
      fields.add(field[1].toLowerCase());
    }
    return (fields.has("sent") || fields.has("date")) && fields.has("to") && fields.has("subject");
  };

  const quoteLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text.trim();
    let previous = i - 1;
    while (previous >= 0 && !lines[previous].text.trim()) previous--;
    // Outlook's separator and its following header describe the same reply.
    const followsOriginalMarker = previous >= 0 && originalMessage.test(lines[previous].text.trim());
    // Some Gmail clients wrap the attribution over two consecutive lines.
    const wrappedGmail = /^On .{0,240}$/.test(text) &&
      i + 1 < lines.length && gmailReply.test(`${text} ${lines[i + 1].text.trim()}`);
    if (gmailReply.test(text) || wrappedGmail || originalMessage.test(text) || (!followsOriginalMarker && isOutlookHeader(i))) {
      quoteLines.push(i);
    }
  }

  const firstQuote = quoteLines[0] ?? lines.length;
  let signatureLine = -1;
  for (let i = 0; i < firstQuote; i++) {
    const text = lines[i].text.trim();
    if (/^-- ?$/.test(text)) {
      signatureLine = i;
      break;
    }
    if (signoff.test(text) && lines.slice(i + 1, Math.min(firstQuote, i + 9)).some((line) => mintBrand.test(line.text.trim()))) {
      signatureLine = i;
      break;
    }
  }

  const boundaries = [
    ...(signatureLine >= 0 ? [{ start: lines[signatureLine].start, kind: "signature" as const }] : []),
    ...quoteLines.map((line) => ({ start: lines[line].start, kind: "quote" as const })),
  ].sort((a, b) => a.start - b.start);
  const segments: EmailBodySegment[] = [];
  let offset = 0;
  let kind: EmailBodySegment["kind"] = "message";
  for (const boundary of boundaries) {
    if (boundary.start <= offset) {
      kind = boundary.kind;
      continue;
    }
    segments.push({ kind, text: body.slice(offset, boundary.start) });
    offset = boundary.start;
    kind = boundary.kind;
  }
  if (offset < body.length) segments.push({ kind, text: body.slice(offset) });
  return segments;
}