import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import busboy from 'busboy';
import { pipeline } from 'node:stream/promises';
import { serverConfig } from '../config.js';
import {
  RetopologyPreparationError,
  type RetopologyProjectSourceFiles,
} from './retopologyProjectPreparationService.js';
import {
  safePreparedMultipartFilename,
  type PreparedMultipartFile,
} from './assetProcessingProxy.js';

const modelFields = ['high_model'] as const;
const supportedModelExtensions = new Set(['.fbx', '.obj', '.glb', '.gltf', '.blend']);
const supportedImageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const supportedReferenceViews = new Set([
  'front',
  'side',
  'top',
  'perspective',
  'detail',
  'other',
]);
const maxReferenceImages = 32;
const maxMetadataBytes = 256 * 1024;

type ModelField = (typeof modelFields)[number];

type StoredModel = {
  path: string;
  size: number;
  originalFilename: string;
};

type StoredReferenceImage = PreparedMultipartFile & {
  originalFilename: string;
};

export type ParsedPreparedRetopologySubmission = {
  sources: RetopologyProjectSourceFiles;
  sourceName: string;
  metadata: string;
  referenceImages: PreparedMultipartFile[];
  cleanup: () => Promise<void>;
};

function uploadError(message: string, statusCode = 400) {
  return new RetopologyPreparationError(message, statusCode);
}

function isModelField(value: string): value is ModelField {
  return modelFields.includes(value as ModelField);
}

function uniqueReferenceFilename(
  filename: string,
  referenceImages: StoredReferenceImage[],
) {
  const used = new Set(referenceImages.map((image) => image.filename.toLowerCase()));
  if (!used.has(filename.toLowerCase())) return filename;
  const parsed = path.parse(filename);
  for (let suffix = 2; suffix <= maxReferenceImages + 1; suffix += 1) {
    const candidate = safePreparedMultipartFilename(
      `${parsed.name}-${suffix}${parsed.ext}`,
      `reference-${suffix}${parsed.ext || '.png'}`,
    );
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  throw uploadError('Reference image filenames could not be made unique.', 400);
}

function normalizePreparedMetadata(
  value: string,
  referenceImages: StoredReferenceImage[],
) {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw uploadError('Metadata must be a JSON object.', 400);
  }
  const currentOptions =
    'options' in parsed &&
    parsed.options &&
    typeof parsed.options === 'object' &&
    !Array.isArray(parsed.options)
      ? parsed.options
      : {};
  const optionRecord = currentOptions as Record<string, unknown>;
  const referenceViews =
    'reference_views' in parsed && Array.isArray(parsed.reference_views)
      ? parsed.reference_views
      : [];
  if (referenceViews.length !== referenceImages.length) {
    throw uploadError(
      'Each uploaded reference image must have one matching reference_views entry.',
      400,
    );
  }
  const usedImages = new Set<number>();
  const normalizedReferenceViews = referenceViews.map((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('filename' in entry) ||
      typeof entry.filename !== 'string'
    ) {
      throw uploadError('Each reference_views entry must contain a filename.', 400);
    }
    const normalizedFilename = safePreparedMultipartFilename(
      entry.filename,
      'reference.png',
    );
    let imageIndex = referenceImages.findIndex(
      (image, index) =>
        !usedImages.has(index) && image.originalFilename === entry.filename,
    );
    if (imageIndex < 0) {
      imageIndex = referenceImages.findIndex(
        (image, index) =>
          !usedImages.has(index) && image.filename === normalizedFilename,
      );
    }
    if (imageIndex < 0) {
      throw uploadError(
        `reference_views filename does not match an uploaded image: ${entry.filename}`,
        400,
      );
    }
    usedImages.add(imageIndex);
    const view =
      'view' in entry && typeof entry.view === 'string'
        ? entry.view.toLowerCase()
        : '';
    if (!supportedReferenceViews.has(view)) {
      throw uploadError(
        `Unsupported reference view "${view || '(missing)'}". Use front, side, top, perspective, detail, or other.`,
        400,
      );
    }
    return {
      ...entry,
      filename: referenceImages[imageIndex].filename,
      view,
    };
  });
  const targetFaces =
    'target_faces' in currentOptions
      ? Number(currentOptions.target_faces)
      : Number.NaN;
  if (!Number.isInteger(targetFaces) || targetFaces < 50 || targetFaces > 5_000) {
    throw uploadError('options.target_faces must be an integer from 50 to 5000.', 400);
  }
  return {
    targetFaces,
    metadata: JSON.stringify({
      ...parsed,
      reference_views: normalizedReferenceViews,
      options: {
        ...currentOptions,
        algorithm: 'agent',
        topology_style: 'quad_dominant',
        preserve_sharp: optionRecord.preserve_sharp !== false,
        preserve_boundary: optionRecord.preserve_boundary !== false,
        render_resolution: 512,
        max_repair_rounds: 2,
        require_closed: optionRecord.require_closed === true,
        // The locally assembled project owns these internal names. They are not
        // user-facing object-mapping settings.
        high_object: 'high',
        reference_object: 'reference_low',
        low_object: 'current_low',
        generated_low_object: 'generated_low_v001',
      },
    }),
  };
}

export async function parsePreparedRetopologySubmission(
  request: IncomingMessage,
): Promise<ParsedPreparedRetopologySubmission> {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw uploadError('Expected multipart/form-data.', 415);
  }
  const contentLength = Number(request.headers['content-length'] ?? 0);
  if (
    Number.isFinite(contentLength) &&
    contentLength > serverConfig.retopologyPrepareMaxUploadBytes
  ) {
    request.resume();
    throw uploadError('Retopology submission upload is too large.', 413);
  }

  const tempDirectory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'li3d-retopology-submit-'),
  );
  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({
      headers: request.headers,
      limits: {
        files: modelFields.length + maxReferenceImages + 1,
        fields: 2,
        parts: modelFields.length + maxReferenceImages + 2,
        fileSize: serverConfig.retopologyPrepareMaxFileBytes,
        fieldSize: maxMetadataBytes,
        headerPairs: 100,
      },
    });
  } catch {
    await fs.promises.rm(tempDirectory, { recursive: true, force: true });
    throw uploadError('Malformed multipart request.', 400);
  }

  try {
    const parsed = await new Promise<{
      models: Map<ModelField, StoredModel>;
      metadata: string;
      targetFaces: number;
      referenceImages: StoredReferenceImage[];
    }>((resolve, reject) => {
      const models = new Map<ModelField, StoredModel>();
      const referenceImages: StoredReferenceImage[] = [];
      const writes: Promise<void>[] = [];
      const openStreams = new Set<fs.WriteStream>();
      let metadata = '';
      let targetFaces = 500;
      let metadataSeen = false;
      let totalFileBytes = 0;
      let failure: RetopologyPreparationError | undefined;
      let settled = false;

      const abortParsing = (error: RetopologyPreparationError) => {
        if (failure) return;
        failure = error;
        request.unpipe(parser);
        for (const stream of openStreams) stream.destroy(error);
        parser.destroy(error);
        request.resume();
      };
      const onRequestAborted = () => abortParsing(uploadError('Request aborted.', 400));
      const onRequestError = () => abortParsing(uploadError('Could not read the upload.', 400));

      const finalize = async (error?: Error) => {
        if (settled) return;
        settled = true;
        request.off('aborted', onRequestAborted);
        request.off('error', onRequestError);
        await Promise.allSettled(writes);
        const finalError =
          failure ??
          (error ? uploadError('Could not parse the multipart upload.', 400) : undefined);
        if (finalError) {
          reject(finalError);
          return;
        }
        if (!models.has('high_model')) {
          reject(uploadError('Missing model field: high_model.', 400));
          return;
        }
        if (!metadataSeen || !metadata.trim()) {
          reject(uploadError('Missing metadata.', 400));
          return;
        }
        try {
          const normalized = normalizePreparedMetadata(metadata, referenceImages);
          metadata = normalized.metadata;
          targetFaces = normalized.targetFaces;
        } catch (error) {
          reject(
            error instanceof RetopologyPreparationError
              ? error
              : uploadError('Metadata must be valid JSON.', 400),
          );
          return;
        }
        const empty = [...models.entries()].find(([, model]) => model.size === 0);
        if (empty) {
          reject(uploadError(`${empty[0]} must not be empty.`, 400));
          return;
        }
        resolve({ models, metadata, targetFaces, referenceImages });
      };

      parser.on('field', (fieldName, value, info) => {
        if (fieldName !== 'metadata') {
          abortParsing(uploadError(`Unexpected text field: ${fieldName}.`, 400));
          return;
        }
        if (metadataSeen) {
          abortParsing(uploadError('Duplicate metadata field.', 400));
          return;
        }
        if (info.valueTruncated) {
          abortParsing(uploadError('Metadata is too large.', 413));
          return;
        }
        metadataSeen = true;
        metadata = value;
      });

      parser.on('file', (fieldName, file, info) => {
        const isModel = isModelField(fieldName);
        if (!isModel && fieldName !== 'reference_images') {
          file.resume();
          abortParsing(uploadError(`Unexpected file field: ${fieldName}.`, 400));
          return;
        }
        if (isModel && models.has(fieldName)) {
          file.resume();
          abortParsing(uploadError(`Duplicate model field: ${fieldName}.`, 400));
          return;
        }
        if (!isModel && referenceImages.length >= maxReferenceImages) {
          file.resume();
          abortParsing(uploadError(`At most ${maxReferenceImages} reference images are allowed.`, 400));
          return;
        }

        const extension = path.extname(info.filename).toLowerCase();
        if (isModel && !supportedModelExtensions.has(extension)) {
          file.resume();
          abortParsing(uploadError(`${fieldName} must be FBX, OBJ, or GLB.`, 415));
          return;
        }
        if (!isModel && !supportedImageExtensions.has(extension)) {
          file.resume();
          abortParsing(uploadError('Reference images must be PNG, JPG, or WEBP.', 415));
          return;
        }

        const index = isModel ? fieldName : `reference-${referenceImages.length}`;
        const filePath = path.join(tempDirectory, `${index}${extension}`);
        const output = fs.createWriteStream(filePath, { flags: 'wx' });
        openStreams.add(output);
        output.on('close', () => openStreams.delete(output));
        const storedModel = isModel
          ? {
              path: filePath,
              size: 0,
              originalFilename: safePreparedMultipartFilename(info.filename, `model${extension}`),
            }
          : undefined;
        if (isModel) models.set(fieldName, storedModel!);
        const reference = !isModel
          ? {
              fieldName: 'reference_images' as const,
              filePath,
              filename: uniqueReferenceFilename(
                safePreparedMultipartFilename(
                  info.filename,
                  `reference-${referenceImages.length}${extension}`,
                ),
                referenceImages,
              ),
              originalFilename: info.filename,
              size: 0,
              contentType: info.mimeType,
            }
          : undefined;
        if (reference) referenceImages.push(reference);

        file.on('data', (chunk: Buffer) => {
          totalFileBytes += chunk.byteLength;
          if (storedModel) storedModel.size += chunk.byteLength;
          if (reference) reference.size += chunk.byteLength;
          if (totalFileBytes > serverConfig.retopologyPrepareMaxUploadBytes) {
            abortParsing(uploadError('Retopology submission upload is too large.', 413));
          }
        });
        file.on('limit', () => {
          abortParsing(uploadError(`${fieldName} is too large.`, 413));
        });
        writes.push(pipeline(file, output).catch((error: unknown) => {
          if (!failure) {
            abortParsing(
              error instanceof RetopologyPreparationError
                ? error
                : uploadError(`Could not store ${fieldName}.`, 400),
            );
          }
        }));
      });

      parser.on('filesLimit', () => abortParsing(uploadError('Too many files.', 400)));
      parser.on('fieldsLimit', () => abortParsing(uploadError('Too many text fields.', 400)));
      parser.on('partsLimit', () => abortParsing(uploadError('Too many multipart fields.', 400)));
      parser.on('error', (error) => void finalize(
        error instanceof Error ? error : new Error('Multipart parser failed.'),
      ));
      parser.on('finish', () => void finalize());
      request.on('aborted', onRequestAborted);
      request.on('error', onRequestError);
      request.pipe(parser);
    });

    return {
      sources: {
        highModelPath: parsed.models.get('high_model')!.path,
        targetFaces: parsed.targetFaces,
      },
      sourceName: parsed.models.get('high_model')!.originalFilename,
      metadata: parsed.metadata,
      referenceImages: parsed.referenceImages,
      cleanup: async () => {
        await fs.promises.rm(tempDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.promises.rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}
