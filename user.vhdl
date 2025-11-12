-- Logic Circuit Lab export

library IEEE;
use IEEE.STD_LOGIC_1164.ALL;

entity logic_circuit_lab is
  port (
    test : out STD_LOGIC
  );
end entity logic_circuit_lab;

architecture behavioral of logic_circuit_lab is
  signal and_g1_0 : STD_LOGIC;
  signal a : STD_LOGIC;
  signal b : STD_LOGIC;
begin
  and_g1_0 <= (a) and (b); -- AND
  a <= '1'; -- Input A
  b <= '0'; -- Input B
  test <= and_g1_0; -- Output Test
end architecture behavioral;
