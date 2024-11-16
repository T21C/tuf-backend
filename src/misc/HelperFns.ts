export const arraySum = (arr: any[]) => {
    return arr.reduce(add, 0);
}

function add(accumulator: number, a: number) {
  return accumulator + a;
}