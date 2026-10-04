import busboy from 'busboy';
import type { Request } from 'express';
import { ServiceError, invalid } from '../errors';

export interface UploadedFile {
  filename: string;
  body: Buffer;
}

export interface MultipartForm {
  fields: Record<string, string>;
  files: UploadedFile[];
}

/** Buffers a multipart upload, rejecting any file over `maxFileBytes` or more than `maxFiles`. */
export function parseMultipart(
  req: Request,
  maxFileBytes: number,
  maxFiles: number,
): Promise<MultipartForm> {
  return new Promise((resolve, reject) => {
    let parser: busboy.Busboy;
    try {
      parser = busboy({
        headers: req.headers,
        preservePath: true,
        limits: { fileSize: maxFileBytes, files: maxFiles, fields: 32, fieldSize: 4096 },
      });
    } catch {
      reject(invalid('Expected a multipart/form-data body'));
      return;
    }
    const fields: Record<string, string> = {};
    const files: UploadedFile[] = [];
    let failure: ServiceError | undefined;

    parser.on('field', (name, value) => {
      fields[name] = value;
    });
    parser.on('file', (_name, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('limit', () => {
        failure = new ServiceError(413, 'payload_too_large', 'File exceeds the upload size limit');
        stream.resume();
      });
      stream.on('end', () => {
        if (failure == null) {
          files.push({ filename: info.filename ?? 'file', body: Buffer.concat(chunks) });
        }
      });
    });
    parser.on('filesLimit', () => {
      failure = new ServiceError(413, 'payload_too_large', 'Too many files in one upload');
    });
    parser.on('error', () => reject(invalid('Malformed multipart body')));
    parser.on('close', () => (failure != null ? reject(failure) : resolve({ fields, files })));
    req.pipe(parser);
  });
}
