// Fixture : un fichier qui utilise Drizzle ORM. L'extracteur doit
// détecter les writes et reads sur la table `reviews` (ici on simule
// un schéma Drizzle — pas besoin du vrai package).
// @ts-nocheck — fixture stub, pas de runtime check réel.

// @ts-expect-error — pas de vrai package, on simule l'import pour déclencher le gate
import { eq } from 'drizzle-orm'

declare const db: any
declare const reviews: any
declare const users: any

export async function addReview(userId: string, content: string): Promise<void> {
  await db.insert(reviews).values({ userId, content })
}

export async function markReviewApproved(id: string): Promise<void> {
  await db.update(reviews).set({ status: 'approved' }).where(eq(reviews.id, id))
}

export async function removeReview(id: string): Promise<void> {
  await db.delete(reviews).where(eq(reviews.id, id))
}

export async function getReview(id: string): Promise<unknown> {
  return await db.select().from(reviews).where(eq(reviews.id, id))
}

// Lecture jointe : doit créer un read sur `users` aussi.
export async function getReviewWithAuthor(id: string): Promise<unknown> {
  return await db
    .select()
    .from(reviews)
    .innerJoin(users, eq(reviews.userId, users.id))
    .where(eq(reviews.id, id))
}

// Ne doit PAS produire de false positive : `this` / array call.
export async function noise(): Promise<void> {
  const arr: number[] = []
  arr.splice(0, 0)  // pas un write ORM
  const set = new Set<number>()
  set.delete(1)  // pas un write ORM — but would match `.delete(...)` naively!
  void set
}
