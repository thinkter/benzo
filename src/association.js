import { realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { atomicJson, canonicalPath, hash, homeDirectory, readJson } from "./state.js";

function associationPath(cwd) {
  return join(homeDirectory(), "associations", `${hash(canonicalPath(cwd))}.json`);
}

export function associatedManifest(cwd) {
  let association;
  try {
    association = readJson(associationPath(cwd));
  } catch {
    throw new Error("Cannot read Benzo manifest association. Run benzo unlink, then link it again.");
  }
  if (association === undefined) return undefined;
  if (!association || association.schemaVersion !== 1 || typeof association.manifest !== "string" ||
      association.cwd !== canonicalPath(cwd) || !isAbsolute(association.manifest))
    throw new Error("Invalid Benzo manifest association. Run benzo unlink, then link it again.");
  return association.manifest;
}

// The CLI validates the manifest before replacing an existing association.
export function associateManifest(cwd, filename) {
  const manifest = realpathSync(resolve(cwd, filename));
  atomicJson(associationPath(cwd), { schemaVersion: 1, cwd: canonicalPath(cwd), manifest });
  return manifest;
}

export function removeAssociation(cwd) {
  rmSync(associationPath(cwd), { force: true });
}
