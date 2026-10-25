#!/bin/bash
# Clears the local workspace the browser walkthroughs use, so each run starts empty.
cd /home/user/AgencyOS
node /tmp/claude-0/-home-user-AgencyOS/becc8a9d-87ff-5e3d-ba68-4cadff714271/scratchpad/clean-local-org.mjs | tail -2
psql -q -h 127.0.0.1 -p 54333 -U postgres -d agencyos_e2e -c "delete from \"User\" where email='owner@agencyos.local'" 
