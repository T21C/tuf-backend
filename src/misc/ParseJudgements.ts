export interface JudgementForm {
  tooEarly: string;
  early: string;
  ePerfect: string;
  perfect: string;
  lPerfect: string;
  late: string;
  [key: string]: string;
}

export const parseJudgements = (
  updatedForm: JudgementForm,
): (number | null)[] => {
  const judgementFields = [
    'tooEarly',
    'early',
    'ePerfect',
    'perfect',
    'lPerfect',
    'late',
  ];

  const parsedJudgements: any = {};
  judgementFields.forEach(field => {
    const parsedValue = parseInt(updatedForm[field], 10);
    parsedJudgements[field] = Number.isNaN(parsedValue) ? null : parsedValue;
  });

  return judgementFields.map(field => parsedJudgements[field]);
};
