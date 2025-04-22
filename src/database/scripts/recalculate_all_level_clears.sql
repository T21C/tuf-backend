-- Script to recalculate clear counts for all levels
-- This script calls the recalculate_level_clear_count procedure for each level

-- Create a temporary table to store all level IDs
CREATE TEMPORARY TABLE IF NOT EXISTS temp_level_ids AS
SELECT id FROM levels;

-- Call the procedure for each level
DELIMITER //

CREATE PROCEDURE recalculate_all_level_clears()
BEGIN
    DECLARE done INT DEFAULT FALSE;
    DECLARE level_id INT;
    DECLARE cur CURSOR FOR SELECT id FROM temp_level_ids;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;

    OPEN cur;
    
    read_loop: LOOP
        FETCH cur INTO level_id;
        IF done THEN
            LEAVE read_loop;
        END IF;
        
        -- Call the recalculate procedure for this level
        CALL recalculate_level_clear_count(level_id);
    END LOOP;
    
    CLOSE cur;
    
    -- Drop the temporary table
    DROP TEMPORARY TABLE IF EXISTS temp_level_ids;
END //

DELIMITER ;

-- Execute the procedure
CALL recalculate_all_level_clears();

-- Drop the procedure after use
DROP PROCEDURE IF EXISTS recalculate_all_level_clears; 