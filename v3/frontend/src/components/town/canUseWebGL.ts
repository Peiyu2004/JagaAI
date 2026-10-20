/**
 * Copy of canUseWebGL() from TownScene.tsx. Kept separate so the Command page can
 * decide between 3D and 2D without importing TownScene (and three.js) eagerly.
 */
export function canUseWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}
