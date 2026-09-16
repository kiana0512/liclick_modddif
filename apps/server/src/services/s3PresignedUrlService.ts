import { createHash, createHmac } from 'node:crypto';

export type S3PresignConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

type PresignInput = {
  method: 'DELETE' | 'GET' | 'HEAD' | 'PUT';
  objectKey: string;
  expiresInSeconds: number;
  headers?: Record<string, string>;
  now?: Date;
};

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: Buffer | string, value: string) {
  return createHmac('sha256', key).update(value).digest();
}

function awsEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalObjectPath(endpoint: URL, bucket: string, objectKey: string) {
  const endpointSegments = endpoint.pathname.split('/').filter(Boolean);
  const segments = [...endpointSegments, bucket, ...objectKey.split('/').filter(Boolean)];
  return `/${segments.map(awsEncode).join('/')}`;
}

function amzTimestamp(now: Date) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

export function createS3Presigner(config: S3PresignConfig) {
  const endpoint = new URL(config.endpoint);

  return (input: PresignInput) => {
    const now = input.now ?? new Date();
    const amzDate = amzTimestamp(now);
    const date = amzDate.slice(0, 8);
    const credentialScope = `${date}/${config.region}/s3/aws4_request`;
    const normalizedHeaders = Object.fromEntries(
      Object.entries(input.headers ?? {}).map(([name, value]) => [
        name.trim().toLowerCase(),
        value.trim().replace(/\s+/g, ' '),
      ]),
    );
    normalizedHeaders.host = endpoint.host;
    const signedHeaderNames = Object.keys(normalizedHeaders).sort();
    const signedHeaders = signedHeaderNames.join(';');
    const canonicalHeaders = signedHeaderNames
      .map((name) => `${name}:${normalizedHeaders[name]}\n`)
      .join('');
    const query = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${config.accessKeyId}/${credentialScope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(input.expiresInSeconds),
      'X-Amz-SignedHeaders': signedHeaders,
    });
    if (config.sessionToken) query.set('X-Amz-Security-Token', config.sessionToken);
    const canonicalQuery = [...query.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${awsEncode(name)}=${awsEncode(value)}`)
      .join('&');
    const canonicalPath = canonicalObjectPath(endpoint, config.bucket, input.objectKey);
    const canonicalRequest = [
      input.method,
      canonicalPath,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256(canonicalRequest),
    ].join('\n');
    const dateKey = hmac(`AWS4${config.secretAccessKey}`, date);
    const regionKey = hmac(dateKey, config.region);
    const serviceKey = hmac(regionKey, 's3');
    const signingKey = hmac(serviceKey, 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    const url = new URL(endpoint);
    url.pathname = canonicalPath;
    url.search = `${canonicalQuery}&X-Amz-Signature=${signature}`;
    return url.toString();
  };
}
