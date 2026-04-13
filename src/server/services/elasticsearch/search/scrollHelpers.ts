export function shouldUseRegularSearch(sortOptions: any[]): boolean {
  return sortOptions.some(
    option =>
      option._script !== undefined ||
      (typeof option === 'object' && Object.keys(option).some(key => key === '_script')),
  );
}

export function isRandomSort(sortOptions: any[]): boolean {
  return sortOptions.some(option => option._script?.script === 'Math.random()');
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

  return optimizedQuery;
}
