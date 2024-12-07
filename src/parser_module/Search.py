from Core import *
import os, sys
from io import StringIO
from datetime import datetime
from time import perf_counter
import time

chartPathDef = "cache/charts.json"
passPathDef = "cache/passes.json"
playerPathDef = "cache/players.json"
leaderboardPathDef = "cache/playerlist.json"
useSavedDef = 1

# uses custom-made result objects defined within Core.py
# those have getitem and behave like a dictionary
# call .get() to pull the dict formatted data from it
# named with PascalCase instead of camelCase

def initData(chartPath, passPath, playerPath, useSaved):
    if chartPath and passPath and playerPath and useSaved:
        if os.path.exists(chartPath) and os.path.exists(passPath) and os.path.exists(playerPath):
            print("using saved...")
            return DataScraper(chartPath, passPath, playerPath)
        else:
            return DataScraper(chartPathDef, passPathDef, playerPathDef, True)
    else:
        return DataScraper(chartPathDef, passPathDef, playerPathDef, True)


def searchByChart(chartId: int, chartPath=chartPathDef, passPath=passPathDef, playerPath=playerPathDef, useSaved=useSavedDef, data=None, getDates=False) \
        -> (list, list):
    util = Utils()
    directCall = False
    if data is None:
        directCall = True
        data = initData(chartPath, passPath, playerPath, useSaved)

    # Performance monitoring
    performance_data = {}

    # Measure time for getting chart
    start_time = time.perf_counter()
    chart = data.charts.get(chartId)
    end_time = time.perf_counter()
    performance_data['get_chart'] = end_time - start_time

    if not chart:
        print(f"Chart ID {chartId} not found")
        return []

    # Measure time for finding passes
    start_time = time.perf_counter()
    validPasses = [
        Pass for Pass in data.passes
        if Pass["levelId"] == chartId 
    ]
    end_time = time.perf_counter()
    performance_data['find_passes'] = end_time - start_time

    if not validPasses:
        print(f"No passes found for chart ID {chartId}")
        return []

    Scores = []
    for Pass in validPasses:
        try:
            date_str = Pass["vidUploadTime"].split(".")[0]
            date = datetime.strptime(date_str, "%Y-%m-%dT%H:%M:%S")
        except Exception as e:
            print(f"Error parsing date: {Pass['vidUploadTime']}, using today. Error: {e}")
            date = datetime.today()
            
        # Convert judgements array to object structure
        judgements_array = [
            Pass["judgements"]["earlyDouble"],
            Pass["judgements"]["earlySingle"],
            Pass["judgements"]["ePerfect"],
            Pass["judgements"]["perfect"],
            Pass["judgements"]["lPerfect"],
            Pass["judgements"]["lateSingle"],
            Pass["judgements"]["lateDouble"]
        ]
        
        Scores.append(ResultObj().updateParams({
            "player": Pass["player"],
            "playerId": Pass["playerId"],
            "song": chart["song"],
            "artist": chart["artist"],
            "score": util.getScoreV2(Pass, chart),
            "pguDiff": chart["pguDiff"],
            "Xacc": util.getXacc(judgements_array),
            "speed": Pass["speed"] or 1.0,
            "isWorldsFirst": False,
            "vidLink": Pass["vidLink"],
            "feelingRating": Pass["feelingRating"],
            "date": date,
            "is12K": Pass["is12K"],
            "is16K": Pass.get("is16K", False),
            "isNoHold": Pass["isNoHoldTap"],
            "judgements": judgements_array,
            "pdnDiff": chart["pdnDiff"],
            "chartId": chart["id"],
            "passId": Pass["id"],
            "baseScore": chart["baseScore"],
            "isDeleted": Pass["isDeleted"]
        }))
    
    # Measure time for sorting scores
    start_time = time.perf_counter()
    Scores = list(reversed(sorted(Scores, key=lambda x: (x["score"]))))
    end_time = time.perf_counter()
    performance_data['sort_scores'] = end_time - start_time

    datedScores = sorted(Scores, key=lambda x: (x["date"]))
    datedScores[0]["isWorldsFirst"] = True
    if getDates:
        return datedScores
    usedIds = []
    validScores = []
    for score in Scores:
        if score["playerId"] not in usedIds:
            validScores.append(score.get())
            usedIds.append(score['playerId'])

    # Print performance data
    print("Performance Data:", performance_data)

    return validScores







def searchByPlayer(player: dict, data=None, TwvKOnly=False, ppOnly=False, showCharts=True) -> (dict, dict):
    # Performance monitoring
    performance_data = {
        'init_data': 0,
        'find_passes': 0,
        'process_scores': 0,
        'sort_scores': 0,
        'calculate_stats': 0,
        'wf_check': 0
    }

    start_time = time.perf_counter()
    util = Utils()
    directCall = False
    if data is None:
        directCall = True
        data = initData(chartPath, passPath, playerPath, useSaved)
    end_time = time.perf_counter()
    performance_data['init_data'] += end_time - start_time

    # Use a dictionary to map player IDs to their passes
    player_passes_dict = {p["playerId"]: [] for p in data.passes}
    for Pass in data.passes:
        player_passes_dict[Pass["playerId"]].append(Pass)

    # Retrieve passes for the current player
    start_time = time.perf_counter()
    playerPasses = player_passes_dict.get(player["id"], [])
    end_time = time.perf_counter()
    performance_data['find_passes'] += end_time - start_time

    # Process scores
    start_time = time.perf_counter()
    Scores = []
    uPasses = 0
    firstPasses = 0
    XaccList = []
    topDiff = ["P", 1]
    top12kDiff = ["P", 1]
    for Pass in playerPasses:
        chartId = Pass["levelId"]
        if chartId not in data.charts:
            continue
        chart = data.charts[chartId]
        isWorldsFirst = Pass["isWorldsFirst"]  # Use precomputed WF status
        if isWorldsFirst:
            firstPasses += 1
        try:
            date_str = Pass["vidUploadTime"].split(".")[0]
            date = datetime.strptime(date_str, "%Y-%m-%dT%H:%M:%S")
        except Exception as e:
            print(f"Error parsing date: {Pass['vidUploadTime']}, using fallback. Error: {e}")
            date = datetime(2022, 1, 1)
        if not Pass["speed"]:
            speed = 1.0
        else:
            speed = Pass["speed"]
        Scores.append(ResultObj().updateParams({
                            "player": Pass["player"],
                            "playerId": player["id"],
                            "song": chart["song"],
                            "artist": chart["artist"],
                            "score": util.getScoreV2(Pass, chart),
                            "pguDiff": chart["pguDiff"],
                            "Xacc": util.getXacc(Pass["judgements"]),
                            "speed": speed,
                            "isWorldsFirst": isWorldsFirst,
                            "vidLink": Pass["vidLink"],
                            "feelingRating": Pass["feelingRating"],
                            "date": date,
                            "is12K": Pass["is12K"],
                            "is16K": Pass["is16K"],
                            "isNoHold": Pass["isNoHoldTap"],
                            "judgements": Pass["judgements"],
                            "pdnDiff": chart["pdnDiff"],
                            "chartId": chart["id"],
                            "passId": Pass["id"],
                            "baseScore": chart["baseScore"],
                            "isDeleted": Pass["isDeleted"]  
                       }))
        try:
            if not Pass["isDeleted"]:
                pgu = chart["pguDiff"][0]
                num = int(chart["pguDiff"][1:])
                if data.pguSort[topDiff[0]] < data.pguSort[pgu]:
                    topDiff[0] = pgu
                    topDiff[1] = num
                if data.pguSort[top12kDiff[0]] < data.pguSort[pgu] and Pass["is12K"]:
                    top12kDiff[0] = pgu
                    top12kDiff[1] = num

                if data.pguSort[topDiff[0]] == data.pguSort[pgu] and int(topDiff[1]) < num:
                    topDiff[1] = num
                if data.pguSort[top12kDiff[0]] == data.pguSort[pgu] and int(top12kDiff[1]) < num and Pass["is12K"]:
                    top12kDiff[1] = num
        except:
            pass

    end_time = time.perf_counter()
    performance_data['process_scores'] += end_time - start_time

    # Sort and filter scores
    start_time = time.perf_counter()
    Scores = list(reversed(sorted(Scores, key=lambda x: x["score"])))
    usedIds = []
    validScores = []
    for Score in Scores:
        if Score["chartId"] not in usedIds and (not TwvKOnly or Score["is12K"]):
            validScores.append(Score)
            if Score["pguDiff"][0] == "U":
                uPasses += 1
            usedIds.append(Score["chartId"])
            XaccList.append(Score["Xacc"])
    end_time = time.perf_counter()
    performance_data['sort_scores'] += end_time - start_time

    # Calculate final stats
    start_time = time.perf_counter()
    notDeletedScores = [Score for Score in validScores if not Score["isDeleted"]]
    rankedScore = util.getRankedScore([Score["score"] for Score in notDeletedScores])
    general,ppScore,wfScore,tvwKScore = util.calculateScores(notDeletedScores)

    # Print performance data
    
    topDiff = topDiff[0]+str(topDiff[1])
    top12kDiff = top12kDiff[0]+str(top12kDiff[1])

    scoresNew = []

    for Score in validScores:
        scoresNew.append(Score.get())
    if XaccList:
        avgAcc = sum(XaccList[:20])/len(XaccList[:20])
    else:
        avgAcc = 0
    Player = PlayerObj().updateParams({
            "player":player["name"],
            "playerId": player["id"],
            "rankedScore":rankedScore,
            "generalScore": general,
            "ppScore": ppScore,
            "wfScore": wfScore,
            "12kScore": tvwKScore,
            "avgXacc": avgAcc,
            "totalPasses": len(validScores),
            "universalPasses": uPasses,
            "WFPasses": firstPasses,
            "topDiff": topDiff,
            "top12kDiff": top12kDiff,
            "country": player["country"]})
    if showCharts:
        Player.addScores(scoresNew)
        
    end_time = time.perf_counter()
    performance_data['calculate_stats'] += end_time - start_time
    return Player.get(), performance_data


def searchAllPlayers(chartPath=chartPathDef, passPath=passPathDef, playerPath=playerPathDef, useSaved=useSavedDef, sortBy="rankedScore", data=None, disableCharts=True, TwvKOnly=False, reverse=False):
    # Aggregate performance monitoring
    total_performance = {
        'init_data': 0,
        'find_passes': 0,
        'process_scores': 0,
        'sort_scores': 0,
        'calculate_stats': 0,
        'wf_check': 0,
        'total_time': 0
    }

    start_time = time.perf_counter()
    util = Utils()
    directCall = False
    if data is None:
        directCall = True
        data = initData(chartPath, passPath, playerPath, useSaved)

    total_performance['init_data'] += time.perf_counter() - start_time
    playerLeaderboard = []
    i = 0
    n = len(data.players)
    print("Players checked:")
    for player in data.players:
        i += 1
        print("\r",round(i / n * 100,3), "%          ", end="", flush=True)
        if player["isBanned"]:
            continue
        search, perf_data = searchByPlayer(player, data=data, TwvKOnly=TwvKOnly)
        if search["avgXacc"]:
            playerLeaderboard.append(search)
            if disableCharts:
                 playerLeaderboard[-1]["allScores"] = ""
        
        # Aggregate performance data
        for key in perf_data:
            total_performance[key] += perf_data[key]

    print("\n")
    
    # Sort leaderboard
    start_sort_time = time.perf_counter()
    priority = util.allPassSortPriority.copy()
    priority.remove(sortBy)
    sortCriteria = [sortBy] + priority
    result = sorted(playerLeaderboard, key=lambda x: [x[criteria] for criteria in sortCriteria])
    if reverse:
        result = list(reversed(result))
    total_performance['sort_leaderboard'] = time.perf_counter() - start_sort_time

    # Calculate total execution time
    total_performance['total_time'] = time.perf_counter() - start_time

    # Print performance summary
    print("\nPerformance Summary:")
    print(f"Total execution time: {total_performance['total_time']:.2f}s")
    print("\nTime spent in each subprocess:")
    for key in total_performance:
        if key != 'total_time':
            print(f"{key}: {total_performance[key]:.2f}s ({(total_performance[key]/total_performance['total_time']*100):.1f}%)")

    return result


def searchAllClears(chartPath=chartPathDef , passPath=passPathDef, playerPath=playerPathDef, useSaved=useSavedDef, sortBy="score", data=None, minScore=0, TwvKOnly=False, reverse=False):
    util = Utils()
    directCall = False
    if data is None:
        directCall = True
        data = initData(chartPath, passPath, playerPath, useSaved)

    with open(leaderboardPathDef, "r") as f:
        leaderboard = json.load(f)
    Clears = []
    i = 0
    n = len(leaderboard)
    print("Players checked:")
    for player in leaderboard:
        i += 1
        print("\r",round(i / n * 100,3), "%                   ", end="", flush=True)
        allClears = player["allScores"]
        for clear in allClears:
            # Get chart directly from dictionary
            chart = data.charts.get(clear["chartId"])
            # Skip deleted passes and passes for deleted charts
            if ((not TwvKOnly or clear["is12K"])
                and chart is not None):
                Result = ResultObj().updateParams({"player": player["player"]})
                Result.updateParams(clear)
                Clears.append(Result)
    priority = util.allClearSortPriority.copy()
    priority.remove(sortBy)
    sortCriteria = [sortBy] + priority
    if reverse:
        return [Item.get() for Item in reversed(sorted(Clears, key=lambda x: [x[criteria] for criteria in sortCriteria]))]
    return [Item.get() for Item in sorted(Clears, key=lambda x: [x[criteria] for criteria in sortCriteria])]

if __name__ == "__main__":
    st = perf_counter()
    [print(n) for n in searchAllPlayers(useSaved=0)]
    print(perf_counter()-st, " s")