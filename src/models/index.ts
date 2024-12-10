import {Sequelize} from 'sequelize';
import Level from './Level';
import Pass from './Pass';
import Player from './Player';
import Rating from './Rating';
import RatingDetail from './RatingDetail';
import Judgement from './Judgement';
import RerateSubmission from './RerateSubmission';
import LevelSubmission from './LevelSubmission';
import {
  PassSubmission,
  PassSubmissionJudgements,
  PassSubmissionFlags,
} from './PassSubmission';
import sequelize from '../config/db';
import {initializeAssociations} from './associations';

// Initialize all associations
initializeAssociations();

export const db = {
  sequelize,
  models: {
    Level,
    Pass,
    Player,
    Rating,
    RatingDetail,
    Judgement,
    RerateSubmission,
    LevelSubmission,
    PassSubmission,
    PassSubmissionJudgements,
    PassSubmissionFlags,
  },
};

export default db;
