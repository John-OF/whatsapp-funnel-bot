// CONTENIDO PLACEHOLDER: reemplazar por los textos definitivos de la marca.
// Límites de WhatsApp: botones ≤ 20 caracteres, cuerpo interactivo ≤ 1024 (ver tests/content-limits).

import type { FlowLinks } from '../flow/types.js';

export const CONSENT_VERSION = 'v1-placeholder';

export const buttons = {
  start: 'Empezar',
  consentYes: 'Acepto',
  consentNo: 'No acepto',
  yes: 'Sí',
  no: 'No',
  otherTopic: 'Otro tema',
  seeProducts: 'Ver productos',
  menu: 'Menú',
  buy: 'Comprar',
  seeOthers: 'Ver otros',
  paid: 'Ya pagué',
  bookSession: 'Agendar sesión',
} as const;

export const menuOptions = {
  learn: { title: 'Aprender gratis', description: 'Videos y guías para empezar hoy' },
  products: { title: 'Ver productos', description: 'Herramientas digitales para tus finanzas' },
  booking: { title: 'Agendar sesión', description: 'Sesión exploratoria 1 a 1' },
} as const;

export const messages = {
  welcome: (l: FlowLinks) =>
    `¡Hola! 💛 Soy tu asistente de educación financiera.\n\nAquí te acompaño a poner orden en tu dinero, paso a paso y sin juicios. Mira este breve video de bienvenida:\n${l.introVideoUrl}\n\nCuando estés lista, toca *Empezar*.`,

  consent: (l: FlowLinks) =>
    `Antes de seguir, necesito tu permiso 🔒\n\nVoy a guardar tu nombre, tu correo y tus respuestas para personalizar tu experiencia y enviarte información relacionada. Puedes leer cómo cuidamos tus datos aquí:\n${l.privacyUrl}\n\n¿Aceptas el tratamiento de tus datos?`,

  consentRejected:
    'Gracias por decírmelo, respeto tu decisión 🌷 No guardé ningún dato tuyo.\n\nSi cambias de opinión, escribe *hola* y empezamos cuando quieras.',

  askName: '¡Gracias! 🎉 ¿Cómo te gustaría que te llame?',
  nameInvalid: 'Necesito un nombre de entre 2 y 40 caracteres. ¿Cómo te llamo?',

  askEmail: (name: string) => `Mucho gusto, ${name} 💛 ¿Cuál es tu correo electrónico?`,
  emailInvalid: 'Ese correo no parece válido 🤔 Revisa que tenga el formato nombre@dominio.com e inténtalo de nuevo.',
  emailGiveUp:
    'No hay problema, seguimos sin tu correo por ahora. Te lo pediré más tarde cuando lo necesitemos 🙂',
  emailNeeded: 'Para continuar necesito tu correo. ¿Cuál es?',

  diagnosticIntro: 'Vamos con un mini diagnóstico de 4 preguntas. Responde con sinceridad, no hay respuestas malas 🌱',
  diagnosticQuestion: (n: number, total: number, text: string) => `Pregunta ${n} de ${total}\n\n${text}`,

  menuBody: (name: string | null, score: number | null, total: number) => {
    const who = name ? `${name}, ` : '';
    const summary = score === null ? '' : `Tu diagnóstico: ${score} de ${total} hábitos financieros sanos 💪\n\n`;
    return `${summary}${who}¿qué quieres hacer ahora?`;
  },
  menuButton: 'Ver opciones',

  resourcesBody: 'Elige el tema que más te interesa y te envío material gratuito 🎁',
  resourcesButton: 'Ver temas',
  resourceSent: (title: string, links: { title: string; url: string }[]) =>
    `Aquí tienes lo mejor sobre *${title}* 📚\n\n${links.map((l) => `• ${l.title}: ${l.url}`).join('\n')}\n\n¿Y ahora?`,

  productsBody: 'Estas son nuestras herramientas digitales. Elige una para ver el detalle 👇',
  productsButton: 'Ver productos',
  productDetail: (name: string, description: string, price: string) =>
    `*${name}* — ${price}\n\n${description}`,

  checkoutLink: (name: string, price: string, url: string) =>
    `Listo 🙌 Este es tu enlace de pago para *${name}* (${price}):\n${url}\n\nCuando termines, toca *Ya pagué*. También lo detectaré automáticamente.`,
  paymentPending: 'Aún no vemos tu pago, puede tardar unos minutos ⏳ Vuelve a tocar *Ya pagué* en un momento.',
  paymentFailed: 'Ups, no pude generar el enlace de pago 😕 Inténtalo de nuevo en unos minutos.',
  paymentExpired: 'Tu enlace de pago venció. Si aún quieres el producto, puedes generar uno nuevo 🙂',
  paymentCanceled: 'El pago fue cancelado. Si quieres intentarlo otra vez, puedes generar un nuevo enlace 🙂',

  delivered: (name: string, productName: string, url: string) =>
    `¡Pago confirmado, ${name}! 🎉 Gracias por tu confianza.\n\nAquí está tu *${productName}*:\n${url}\n\n¿Te gustaría agendar una sesión exploratoria?`,

  booking: (url: string) =>
    `Agenda tu sesión exploratoria aquí 📅\n${url}\n\nYa dejé tu nombre y correo prellenados.`,

  notUnderstood: 'No te entendí 🙂',
  fallbackRestart: 'Empecemos de nuevo 🙂',
} as const;
