/**
 * Previously used to divert non-deterministic Math.random() sorts away from scroll.
 * Seeded random_score sorts are deterministic, so scroll/from-size work like any other sort.
 */
export function shouldUseRegularSearch(_sortOptions: any[]): boolean {
  return false;
}

export function optimizeQueryForScroll(searchQuery: any): any {
  const optimizedQuery = JSON.parse(JSON.stringify(searchQuery));

  if (optimizedQuery.bool?.should) {
    optimizedQuery.bool.should = optimizedQuery.bool.should.map((should: any) => {
      if (should.wildcard) {
        Object.keys(should.wildcard).forEach(field => {
          const value = should.wildcard[field].value;
          if (value.startsWith('*') && !value.endsWith('*')) {
            should.match_phrase = {
              [field]: value.substring(1),
            };
            delete should.wildcard;
          }
        });
      }
      return should;
    });
  }

  // function_score wrapper (seeded random) — optimize the inner bool query
  if (optimizedQuery.function_score?.query?.bool?.should) {
    optimizedQuery.function_score.query = optimizeQueryForScroll(optimizedQuery.function_score.query);
  }

  return optimizedQuery;
}
