// VIOLATION TestedFile — fichier de test pour matcher l'index.ts.
//
// Détection attendue : TestedFile ≥ 1 (associe src/index.ts à ce test).

import { main } from './index.js'

console.log(main())  // marker test "exec" — pas vitest mais suffit pour TestedFile heuristic
