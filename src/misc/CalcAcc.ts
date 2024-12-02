import { arraySum } from "../misc/HelperFns";
import { IJudgements } from '../models/Judgements';

export function calcAcc (inp: IJudgements, raw=false)
    {
        const result = (inp.perfect +
            (inp.ePerfect + inp.lPerfect) * 0.75 +
            (inp.earlySingle + inp.lateSingle) * 0.4 +
            (inp.earlyDouble + inp.lateDouble) * 0.2)
           / arraySum(Object.values(inp))
        if (raw){
            return result
        }
        const digits = 4
        const rounded = Math.round(result * Math.pow(10, digits)) / Math.pow(10, digits);
        return rounded
    }

