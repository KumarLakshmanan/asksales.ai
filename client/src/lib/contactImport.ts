export const getMissingContactImportMappings = (
  columnMapping: Record<string, string>,
) => {
  const mappedTargets = new Set(Object.values(columnMapping));
  return mappedTargets.has('email') || mappedTargets.has('phone') ? [] : [{ value: 'identifier', label: 'Email or Phone' }];
};

/** Parse complete CSV records so quoted newlines are preserved in previews. */
export function parseContactCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closedQuote = false;
  const input = text.replace(/^\uFEFF/, "");
  const finishCell = () => { row.push(cell.trim()); cell = ""; closedQuote = false; };
  const finishRow = () => {
    finishCell();
    if (row.some(value => value !== "")) records.push(row);
    row = [];
  };
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else cell += char;
    } else if (char === ',') finishCell();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      finishRow();
    } else if (char === '"' && !cell.trim() && !closedQuote) { cell = ""; quoted = true; }
    else if (char === '"' || (closedQuote && char.trim())) throw new Error("Invalid CSV quoting. Check the quoted values and try again.");
    else cell += char;
  }
  if (quoted) throw new Error("A quoted CSV value is missing its closing quote.");
  if (cell || row.length || closedQuote) finishRow();
  if (records.length < 2) throw new Error("File must contain headers and at least one record.");
  const [headers, ...values] = records;
  if (headers.some(header => !header)) throw new Error("Every CSV column needs a header.");
  if (new Set(headers).size !== headers.length) throw new Error("CSV column headers must be unique. Rename duplicate headers and try again.");
  const invalidIndex = values.findIndex(record => record.length !== headers.length);
  if (invalidIndex >= 0) throw new Error(`Record ${invalidIndex + 2} has a different number of columns than the header.`);
  return { headers, rows: values.slice(0, 5).map(values => Object.fromEntries(headers.map((header, index) => [header, values[index]]))) };
}
