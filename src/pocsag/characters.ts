export function interpretPocsag(
  bits: string,
  mode: "numeric" | "alpha" | "raw",
): string {
  if (mode === "raw") return bits;
  let text = "";
  const width = mode === "numeric" ? 4 : 7;
  for (let i = 0; i + width <= bits.length; i += width) {
    const part = bits.slice(i, i + width);
    if (part.includes("?")) {
      text += "�";
      continue;
    }
    const value = Number.parseInt([...part].reverse().join(""), 2);
    if (mode === "numeric") text += "0123456789.U -]["[value]!;
    else if (value === 0 || value === 3 || value === 4)
      text += `<${value === 0 ? "NUL" : value === 3 ? "ETX" : "EOT"}>`;
    else if (value === 10) text += "\n";
    else if (value === 13) text += "\r";
    else if (value < 32 || value === 127)
      text += `<0x${value.toString(16).padStart(2, "0")}>`;
    else text += String.fromCharCode(value);
  }
  return text;
}
export function pocsagDisplayText(text: string): string {
  return text.replace(/(?:<NUL>|<ETX>|<EOT>)+$/g, "");
}
