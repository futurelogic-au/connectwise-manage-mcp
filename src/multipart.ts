/**
 * Multipart form body for the ConnectWise document upload (POST /system/documents).
 *
 * Built by hand so the body is plain bytes that any fetch accepts, including the
 * undici fetch the client uses when relaxed TLS is on. This file has no imports
 * and no side effects.
 */

export interface MultipartFile {
  fieldName: string;
  fileName: string;
  contentType: string;
  data: Uint8Array;
}

export interface MultipartBody {
  body: Uint8Array;
  contentType: string;
}

const CRLF = "\r\n";

/** A header value made safe: no line breaks, no double quotes. */
function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/"/g, "%22");
}

/** One text field and one file, in that order, as a multipart/form-data body. */
export function buildMultipart(fields: Record<string, string>, file: MultipartFile): MultipartBody {
  const boundary = `----cwmanagemcp${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      encoder.encode(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="${headerValue(name)}"${CRLF}${CRLF}` +
          `${value}${CRLF}`,
      ),
    );
  }

  parts.push(
    encoder.encode(
      `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="${headerValue(file.fieldName)}"; filename="${headerValue(file.fileName)}"${CRLF}` +
        `Content-Type: ${headerValue(file.contentType)}${CRLF}${CRLF}`,
    ),
  );
  parts.push(file.data);
  parts.push(encoder.encode(`${CRLF}--${boundary}--${CRLF}`));

  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const body = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
