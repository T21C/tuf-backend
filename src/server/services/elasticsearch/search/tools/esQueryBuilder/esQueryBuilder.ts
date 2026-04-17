import type { EsQuery } from '@/server/services/elasticsearch/search/tools/esQueryBuilder/esQueryPrimitives.js';

/**
 * Fluent bool composer. Produces a single bool clause; omits empty sections.
 */
export class BoolQueryBuilder {
  private readonly shouldClauses: EsQuery[] = [];
  private readonly mustClauses: EsQuery[] = [];
  private readonly mustNotClauses: EsQuery[] = [];
  private readonly filterClauses: EsQuery[] = [];
  private minShouldMatch: number | undefined;

  should(q: EsQuery): this {
    this.shouldClauses.push(q);
    return this;
  }

  must(q: EsQuery): this {
    this.mustClauses.push(q);
    return this;
  }

  mustNot(q: EsQuery): this {
    this.mustNotClauses.push(q);
    return this;
  }

  filter(q: EsQuery): this {
    this.filterClauses.push(q);
    return this;
  }

  /**
   * When any should() clauses exist, sets minimum_should_match (default 1).
   */
  withMinimumShouldMatch(n: number): this {
    this.minShouldMatch = n;
    return this;
  }

  build(): EsQuery {
    const bool: Record<string, unknown> = {};
    if (this.shouldClauses.length > 0) {
      bool.should = this.shouldClauses;
      bool.minimum_should_match = this.minShouldMatch ?? 1;
    }
    if (this.mustClauses.length > 0) {
      bool.must = this.mustClauses;
    }
    if (this.mustNotClauses.length > 0) {
      bool.must_not = this.mustNotClauses;
    }
    if (this.filterClauses.length > 0) {
      bool.filter = this.filterClauses;
    }
    return { bool };
  }
}
