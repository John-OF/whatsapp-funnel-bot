// CONTENIDO PLACEHOLDER: enlaces de ejemplo. Máximo 10 temas (límite de filas de lista de WhatsApp).

export interface ResourceLink {
  title: string;
  url: string;
}

export interface ResourceTopic {
  id: string;
  title: string; // ≤ 24 caracteres
  description: string; // ≤ 72 caracteres
  links: ResourceLink[];
}

export const resourceTopics: ResourceTopic[] = [
  {
    id: 'budget',
    title: 'Presupuesto',
    description: 'Organiza tus ingresos y gastos',
    links: [
      { title: 'Video: tu primer presupuesto', url: 'https://youtube.com/watch?v=placeholder-presupuesto' },
      { title: 'Plantilla gratuita', url: 'https://drive.google.com/placeholder-presupuesto' },
    ],
  },
  {
    id: 'saving',
    title: 'Ahorro',
    description: 'Hábitos para ahorrar sin sufrir',
    links: [{ title: 'Video: ahorro que sí funciona', url: 'https://youtube.com/watch?v=placeholder-ahorro' }],
  },
  {
    id: 'debts',
    title: 'Deudas',
    description: 'Sal de deudas con un plan claro',
    links: [
      { title: 'Video: método bola de nieve', url: 'https://youtube.com/watch?v=placeholder-deudas' },
      { title: 'Guía de deudas (PDF)', url: 'https://drive.google.com/placeholder-deudas' },
    ],
  },
  {
    id: 'emergency',
    title: 'Fondo de emergencia',
    description: 'Cuánto necesitas y cómo armarlo',
    links: [{ title: 'Video: tu fondo de emergencia', url: 'https://youtube.com/watch?v=placeholder-emergencia' }],
  },
  {
    id: 'business',
    title: 'Emprendimiento',
    description: 'Finanzas para tu negocio',
    links: [{ title: 'Video: separa tus finanzas', url: 'https://youtube.com/watch?v=placeholder-emprendimiento' }],
  },
];
