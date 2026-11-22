import { defineConfig } from 'vitest/config';

/**
 * L'ouverture d'une base PGlite en mémoire et les migrations prennent plusieurs secondes sur une machine chargée
 * (constaté le 21/11 : échec de démarrage de trois fichiers pendant qu'un autre travail tournait).
 * Les délais par défaut (5 s par test, 10 s par préparation) sont donc élargis ; aucun test n'est rendu moins strict.
 *
 * Chaque fichier de test ouvre sa propre base embarquée (WebAssembly), qui réserve beaucoup de mémoire. Avec huit fichiers
 * lancés ensemble et des serveurs en marche à côté, les processus de test tombaient en « out of memory » (constaté le 22/11).
 * Quatre fichiers à la fois au plus : la suite est un peu plus longue, et elle tient.
 */
export default defineConfig({
  test: { testTimeout: 20_000, hookTimeout: 60_000, maxWorkers: 4 },
});
