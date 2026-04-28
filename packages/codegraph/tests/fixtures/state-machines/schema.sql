-- Fixture phase 3.6 #2 : PG DEFAULT sur une colonne status.
-- La valeur par défaut est `'pending'` — un state de ApprovalStatus
-- (fixture types.ts). Sans le scan SQL defaults, la valeur serait déjà
-- visible ici via le listener `approval.submit` (fixture approval-service.ts),
-- donc on ajoute un concept *exclusif* pour vérifier le pass SQL isolément.

CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY,
  phase VARCHAR(20) DEFAULT 'drafting',  -- DocumentPhase.drafting, pur SQL default
  created_at TIMESTAMPTZ DEFAULT NOW()   -- pas un state (valeur = fonction)
);

-- Cas multi-table pour prouver qu'on ne s'arrête pas au premier CREATE.
CREATE TABLE IF NOT EXISTS notes (
  id UUID PRIMARY KEY,
  phase VARCHAR(20) DEFAULT 'reviewing'  -- DocumentPhase.reviewing
);
