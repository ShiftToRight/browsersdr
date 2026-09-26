/** ETSI TS 101 756 annex C: complete EBU Latin repertoire. */
const EBU = [
  "\u0000ĘĮŲĂĖĎȘȚĊ\n\u000bĠĹŻŃ",
  "ąęįųăėďșțċŇĚġĺż\u001f",
  " !\"#ł%&'()*+,-./",
  "0123456789:;<=>?",
  "@ABCDEFGHIJKLMNO",
  "PQRSTUVWXYZ[Ů]Ł_",
  "Ąabcdefghijklmno",
  "pqrstuvwxyz«ů»ĽĦ",
  "áàéèíìóòúùÑÇŞß¡Ÿ",
  "âäêëîïôöûüñçşğıÿ",
  "ĶŅ©ĢĞěňőŐ€£$ĀĒĪŪ",
  "ķņĻģļİńűŰ¿ľ°āēīū",
  "ÁÀÉÈÍÌÓÒÚÙŘČŠŽÐĿ",
  "ÂÄÊËÎÏÔÖÛÜřčšžđŀ",
  "ÃÅÆŒŷÝÕØÞŊŔĆŚŹŤð",
  "ãåæœŵýõøþŋŕćśźťħ",
].join("");

export function decodeDabText(
  bytes: Uint8Array,
  charset: number,
  trim = true,
): string | undefined {
  let text: string;
  if (charset === 0) text = Array.from(bytes, (byte) => EBU[byte]!).join("");
  else if (charset === 6 || charset === 15) {
    try {
      text = new TextDecoder(charset === 6 ? "utf-16be" : "utf-8", {
        fatal: true,
      }).decode(bytes);
    } catch {
      return undefined;
    }
  } else return undefined;
  const cleaned = Array.from(text, (char) =>
    char.charCodeAt(0) < 32 ? " " : char,
  ).join("");
  return trim ? cleaned.trim() : cleaned;
}
