import { defineConfig } from 'vitest/config';

/**
 * L'ouverture d'une base PGlite en mémoire et les migrations prennent plusieurs secondes sur une machine chargée
 * (constaté le 21/11 : échec de démarrage de trois fichiers pendant qu'un autre travail tournait).
 * Les délais par défaut (5 s par test, 10 s par préparation) sont donc élargis ; aucun test n'est rendu moins strict.
 */
export default defineConfig({
  test: { testTimeout: 20_000, hookTimeout: 60_000 },
});
