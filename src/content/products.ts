// CONTENIDO PLACEHOLDER: productos y enlaces de entrega de ejemplo. Máximo 10 productos.
// Precios en centavos de USD, sin impuestos.

export interface Product {
  id: string;
  name: string; // ≤ 24 caracteres (título de fila)
  shortDescription: string; // ≤ 72 caracteres
  description: string;
  priceCents: number;
  deliveryUrl: string;
}

export const products: Product[] = [
  {
    id: 'guia-digital',
    name: 'Guía Digital',
    shortDescription: 'Tu ruta paso a paso para ordenar tus finanzas',
    description: 'Una guía práctica con ejercicios para ordenar tus finanzas personales en 30 días.',
    priceCents: 900,
    deliveryUrl: 'https://drive.google.com/placeholder-guia-digital',
  },
  {
    id: 'planner-financiero',
    name: 'Planner financiero',
    shortDescription: 'Planifica tu mes, tus metas y tu ahorro',
    description: 'Un planner imprimible y digital para planificar presupuesto, metas y hábitos de ahorro.',
    priceCents: 1200,
    deliveryUrl: 'https://drive.google.com/placeholder-planner',
  },
  {
    id: 'tablero-de-metas',
    name: 'Tablero de metas',
    shortDescription: 'Visualiza y alcanza tus metas financieras',
    description: 'Plantilla para visualizar tus metas financieras y hacerlas medibles.',
    priceCents: 700,
    deliveryUrl: 'https://drive.google.com/placeholder-tablero-de-metas',
  },
];

export function findProduct(id: string): Product | undefined {
  return products.find((p) => p.id === id);
}
