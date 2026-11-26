// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import MirroredChatCard from '../composer/MirroredChatCard.vue';
import { applyLocale, i18n } from '@/i18n';

const mounted: VueWrapper[] = [];
function mountCard(outdated: 'runs' | 'floor' | undefined): VueWrapper {
  const wrapper = mount(MirroredChatCard, { props: { hostName: 'prod-1', outdated }, global: { plugins: [i18n] } });
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(async () => {
  await applyLocale('en');
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount();
});

describe('MirroredChatCard', () => {
  it('says the host is offline while it reconnects', () => {
    const card = mountCard(undefined).get('[data-testid="composer-offline"]');
    expect(card.attributes('role')).toBe('status');
    expect(card.find('.lucide-cloud-off-icon').exists()).toBe(true);
    expect(card.text()).toContain('This chat is read-only until prod-1 reconnects.');
  });

  it('says the host runs a newer Damocles and this app must update, with the download icon', () => {
    const card = mountCard('runs').get('[data-testid="composer-outdated"]');
    expect(card.attributes('role')).toBe('status');
    expect(card.find('.lucide-arrow-down-to-line-icon').exists()).toBe(true);
    expect(card.find('.lucide-cloud-off-icon').exists()).toBe(false);
    expect(card.text()).toBe('prod-1 runs a newer DamoclesThis chat is read-only until this app updates. Its transcript is the copy this computer keeps.');
  });

  it('says the host needs a newer Damocles when its minimum is above this app, with the same note and icon', () => {
    const card = mountCard('floor').get('[data-testid="composer-outdated"]');
    expect(card.find('.lucide-arrow-down-to-line-icon').exists()).toBe(true);
    expect(card.text()).toBe('prod-1 needs a newer DamoclesThis chat is read-only until this app updates. Its transcript is the copy this computer keeps.');
  });

  it('says it in Greek', async () => {
    await applyLocale('el');
    expect(mountCard('runs').text()).toBe('Το prod-1 τρέχει νεότερο DamoclesΑυτή η συνομιλία είναι μόνο για ανάγνωση μέχρι να ενημερωθεί αυτή η εφαρμογή. Η καταγραφή της είναι το αντίγραφο που κρατά αυτός ο υπολογιστής.');
    expect(mountCard('floor').text()).toBe('Το prod-1 χρειάζεται νεότερο DamoclesΑυτή η συνομιλία είναι μόνο για ανάγνωση μέχρι να ενημερωθεί αυτή η εφαρμογή. Η καταγραφή της είναι το αντίγραφο που κρατά αυτός ο υπολογιστής.');
  });
});
