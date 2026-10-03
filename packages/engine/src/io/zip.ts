import JSZip from 'jszip';

/** Same fixed date as `writeXlsx`: two zips of the same files are byte-identical (SPEC 2.1 determinism). */
const FIXED_DATE = new Date(Date.UTC(2020, 0, 1));

export interface ZipEntry {
  /** The path inside the zip, "/"-separated (a folder is just a prefix: "Priority load/Supplier A (converted).xlsx"). */
  path: string;
  bytes: Uint8Array | ArrayBuffer;
}

/** Packs files into one .zip (the batch download, SPEC 5 D). Entries keep the order given. */
export async function writeZip(entries: readonly ZipEntry[]): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const e of entries) zip.file(e.path, e.bytes, { date: FIXED_DATE, createFolders: false });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS' });
}

/** The files of a .zip, in archive order (folders left out). Used to check what `writeZip` produced. */
export async function readZip(bytes: Uint8Array | ArrayBuffer): Promise<ZipEntry[]> {
  const zip = await JSZip.loadAsync(bytes);
  const out: ZipEntry[] = [];
  for (const path of Object.keys(zip.files)) {
    const entry = zip.files[path]!;
    if (entry.dir) continue;
    out.push({ path, bytes: await entry.async('uint8array') });
  }
  return out;
}
