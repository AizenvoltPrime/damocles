import { defineComponent, h } from 'vue';

/**
 * Stand-ins for `@unovis/vue`: happy-dom cannot lay out SVG, and the real components leave timers running
 * past teardown. Each stub renders its slot and records the props it was given.
 */
export const rendered: { container: Record<string, unknown>; bar: Record<string, unknown>; crosshair: Record<string, unknown> } = {
  container: {},
  bar: {},
  crosshair: {},
};

function recorder(name: string, sink?: 'container' | 'bar' | 'crosshair') {
  return defineComponent({
    name,
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => {
        if (sink) rendered[sink] = { ...attrs };
        return h('div', { 'data-stub': name }, slots.default?.());
      };
    },
  });
}

export const VisXYContainer = recorder('VisXYContainer', 'container');
export const VisStackedBar = recorder('VisStackedBar', 'bar');
export const VisAxis = recorder('VisAxis');
export const VisCrosshair = recorder('VisCrosshair', 'crosshair');
export const VisTooltip = recorder('VisTooltip');
