// App-specific navigation helpers for the Tasto Example e-commerce app
import { element, sleep } from '@tasto/test';

export function goHome() {
  return element('tab-home').tap().then(() => sleep(300));
}

export function goProducts() {
  return element('tab-products').tap().then(() => sleep(300));
}

export function goCart() {
  return element('tab-cart').tap().then(() => sleep(300));
}

export function goProfile() {
  return element('tab-profile').tap().then(() => sleep(300));
}
