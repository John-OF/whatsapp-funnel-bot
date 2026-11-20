// CONTENIDO PLACEHOLDER: preguntas de ejemplo. Sí = 1 punto.

export interface DiagnosticQuestion {
  id: string;
  text: string;
}

export const diagnosticQuestions: DiagnosticQuestion[] = [
  { id: 'budget', text: '¿Llevas un registro de tus ingresos y gastos cada mes?' },
  { id: 'saving', text: '¿Ahorras una parte de tus ingresos apenas los recibes?' },
  { id: 'emergency', text: '¿Tienes un fondo para cubrir al menos tres meses de gastos si surge una emergencia?' },
  { id: 'debt', text: '¿Sientes que tus deudas están bajo control?' },
];
