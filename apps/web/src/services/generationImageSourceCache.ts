type PreparedGenerationImage = { blob: Blob; digest?: string };

/** GENERATION-IMAGE-SOURCE/1.0.0: immutable data bytes only, never asset authority.
 * Reusing source preparation does not reuse another project's upload result. */
export class GenerationImageSourceCache {
  private readonly entries = new Map<string, { bytes: number; pending: Promise<PreparedGenerationImage> }>();
  private bytes = 0;

  constructor(private readonly budget = 64 * 1024 * 1024, private readonly limit = 32) {}

  prepare(url: string, load: () => Promise<PreparedGenerationImage>) {
    const existing = this.entries.get(url);
    if (existing) {
      this.entries.delete(url);
      this.entries.set(url, existing);
      return existing.pending;
    }
    // UTF-16 URL plus worst-case UTF-8 decoded bytes, digest and bookkeeping.
    // No runtime/remote URL may be memoized: those sources can change in place.
    const bytes = url.length * 5 + 256;
    const pending = Promise.resolve().then(load);
    if (!url.startsWith('data:image/') || bytes > this.budget || this.limit < 1) return pending;
    while (this.entries.size && (this.entries.size >= this.limit || this.bytes + bytes > this.budget)) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
    const entry = { bytes, pending };
    this.entries.set(url, entry);
    this.bytes += bytes;
    void pending.catch(() => {
      if (this.entries.get(url) !== entry) return;
      this.entries.delete(url);
      this.bytes -= bytes;
    });
    return pending;
  }
}
