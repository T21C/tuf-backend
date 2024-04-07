/* eslint-disable no-unused-vars */
import "./navigation.css"
import React from "react";
import Navigation from "./Navigation";
import { NavLink } from "react-router-dom";

const CompleteNav = () => {
  return (
    <Navigation>
      <NavLink
        className={({ isActive }) =>
          "nav-link " + (isActive ? "active-link" : "")
        }
        to="/levels"
      >
        <li>Levels</li>
      </NavLink>

      {/* <NavLink
        className={({ isActive }) =>
          "nav-link " + (isActive ? "active-link" : "")
        }
        to="/submission"
      >
        <li>submission</li>
      </NavLink> */}

      {/* <NavLink
        className={({ isActive }) =>
          "nav-link " + (isActive ? "active-link" : "")
        }
        to="/leaderboard"
      >
        <li>UNAV</li>
      </NavLink> */}

    </Navigation>
  );
};

export default CompleteNav;