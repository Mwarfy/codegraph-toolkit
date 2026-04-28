// Importe `react` (pas déclaré → missing)
// Importe `lodash/fp` (sous-chemin → normalisé en `lodash`, ok)
import * as React from 'react'
import fp from 'lodash/fp'

export const b = { React, fp }
