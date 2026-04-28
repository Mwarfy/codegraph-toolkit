// Fichier sans import / sans call vers les autres — exports seuls.
// Sert à tester que les exports orphelins apparaissent bien en signatures
// mais qu'aucun call edge n'est émis depuis eux.
export function solo(input: string): number {
  return input.length
}
