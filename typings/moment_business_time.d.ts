import * as moment from 'moment';

declare module 'moment' {
  interface Moment {
    workingDiff: (moment: Moment, unit: unitOfTime.Base, fractions?: boolean) => number;
  }
}

export = moment;
