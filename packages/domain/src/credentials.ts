import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Server-only: no credential is returned by loadConfig or a browser DTO.
export function readLux3dCnKey(): string | undefined {
  if (process.env.LUX3D_CN_API_KEY?.trim()) return process.env.LUX3D_CN_API_KEY.trim();
  const file=process.env.LUX3D_CREDENTIALS_FILE || path.join(homedir(),'.config/lux3d/credentials.json');
  try {const parsed=JSON.parse(readFileSync(file,'utf8'));const key=parsed?.apiKeys?.cn;return typeof key==='string'&&key.trim()?key.trim():undefined;}
  catch {return undefined;}
}
