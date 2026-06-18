export type DccAction =
  | { type: 'import-project'; projectPath: string }
  | { type: 'export-glb'; destinationPath: string }
  | { type: 'apply-texture'; objectName: string; texturePath: string };

export type DccActionResult = {
  ok: boolean;
  message: string;
  payload?: Record<string, unknown>;
};
