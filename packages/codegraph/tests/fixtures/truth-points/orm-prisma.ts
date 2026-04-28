// Fixture : fichier Prisma. Motif `prisma.<model>.<method>(...)`.
// @ts-nocheck — fixture stub sans vrai package.

// @ts-expect-error — le gate se fait sur l'import string
import { PrismaClient } from '@prisma/client'

declare const prisma: PrismaClient

export async function createComment(postId: string, body: string): Promise<void> {
  await prisma.comment.create({ data: { postId, body } })
}

export async function listComments(postId: string): Promise<unknown> {
  return await prisma.comment.findMany({ where: { postId } })
}

export async function deleteComment(id: string): Promise<void> {
  await prisma.comment.delete({ where: { id } })
}

export async function countPosts(): Promise<number> {
  return await prisma.post.count()
}

// Ne doit PAS produire de faux positif : on utilise `otherClient` qui n'est
// pas dans le whitelist des clients Prisma.
declare const otherClient: any
export async function otherCall(): Promise<void> {
  await otherClient.foo.findMany()
}
