import type { ModelFormat } from '@/types/model';

export type ImportModelRequest = {
  file: File;
  format: ModelFormat;
};

export async function readModelFileAsObjectUrl(request: ImportModelRequest) {
  return {
    url: URL.createObjectURL(request.file),
    format: request.format,
    name: request.file.name,
  };
}
