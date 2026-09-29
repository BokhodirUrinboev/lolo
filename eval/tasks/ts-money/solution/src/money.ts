export interface Money {
  amount: number;
  currency: string;
}

export function money(amount: number, currency: string): Money {
  return { amount, currency };
}

export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error("currency mismatch");
  return { amount: a.amount + b.amount, currency: a.currency };
}
