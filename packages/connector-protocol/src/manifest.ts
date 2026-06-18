import { z } from 'zod';

export const connectorManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  host: z.enum(['blender', '3dsmax']),
  version: z.string(),
  protocolVersion: z.string(),
  capabilities: z.array(z.string()),
});

export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;
