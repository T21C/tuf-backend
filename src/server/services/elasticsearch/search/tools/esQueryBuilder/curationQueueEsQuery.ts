import {parseCurationFlow} from '@/misc/utils/data/curationFlow.js';
import {termField, type EsQuery} from './esQueryPrimitives.js';

export function curationQueueMustClauses(options: {flow?: string | null} = {}): EsQuery[] {
  const must: EsQuery[] = [
    termField('toCuration', true),
    termField('isDeleted', false),
    termField('isHidden', false),
  ];
  const flow = parseCurationFlow(options.flow);
  if (flow) {
    must.push(termField('curationFlow', flow));
  }
  return must;
}
